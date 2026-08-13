// @ts-check
import { test, assert, assertEq } from './harness.js';
import { RemoteBigBed } from '../js/io/bigbed.js';

/** @param {Uint8Array} payload */
async function deflate(payload) {
  const plain = /** @type {Uint8Array<ArrayBuffer>} */ (payload);
  const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class W {
  constructor() {
    /** @type {number[]} */
    this.bytes = [];
  }
  /** @param {number} v */
  u8(v) {
    this.bytes.push(v & 0xff);
  }
  /** @param {number} v */
  u16(v) {
    this.u8(v);
    this.u8(v >>> 8);
  }
  /** @param {number} v */
  u32(v) {
    this.u16(v & 0xffff);
    this.u16(Math.floor(v / 65536));
  }
  /** @param {number} v */
  u64(v) {
    this.u32(v >>> 0);
    this.u32(Math.floor(v / 4294967296));
  }
  /** @param {string} s @param {number} [pad] */
  str(s, pad = s.length) {
    for (let i = 0; i < pad; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0);
  }
  /** @param {Uint8Array} b */
  raw(b) {
    for (const v of b) this.bytes.push(v);
  }
  get length() {
    return this.bytes.length;
  }
}

/**
 * Rows for one data block: (chromId, start, end, tab-joined BED9 rest).
 * @param {[number, number, number, string, string, string][]} rows [cid, s, e, name, strand, rgb]
 */
function blockBytes(rows) {
  const w = new W();
  for (const [cid, s, e, name, strand, rgb] of rows) {
    w.u32(cid);
    w.u32(s);
    w.u32(e);
    w.str(`${name}\t100\t${strand}\t${s}\t${e}\t${rgb}`);
    w.u8(0);
  }
  return new Uint8Array(w.bytes);
}

/**
 * Build a small valid bigBed: 2 chroms, one compressed block per chrom, and
 * a TWO-LEVEL R-tree (internal root -> leaf) so the tree walk is exercised.
 */
async function buildFixture() {
  const blkA = await deflate(
    blockBytes([
      [0, 100, 500, 'alpha', '+', '255,0,0'],
      [0, 450, 900, 'beta', '-', '0,204,204'],
    ]),
  );
  const blkB = await deflate(blockBytes([[1, 10, 20, 'g1', '+', '0,0,0']]));

  const chromTreeOffset = 64;
  const chromTreeSize = 32 + 4 + 2 * (4 + 8);
  const dataOffset = chromTreeOffset + chromTreeSize;
  const blkAOff = dataOffset + 8; // after the u64 item count
  const blkBOff = blkAOff + blkA.length;
  const rtreeOffset = blkBOff + blkB.length;
  const leafOffset = rtreeOffset + 48 + 4 + 24; // after internal root with 1 item

  const w = new W();
  // header
  w.u32(0x8789f2eb);
  w.u16(4); // version
  w.u16(0); // zoomLevels
  w.u64(chromTreeOffset);
  w.u64(dataOffset);
  w.u64(rtreeOffset);
  w.u16(9); // fieldCount
  w.u16(9); // definedFieldCount
  w.u64(0); // autoSql
  w.u64(0); // totalSummary
  w.u32(65536); // uncompressBufSize (blocks are zlib)
  w.u64(0); // reserved
  assertEq(w.length, 64);
  // chrom B+ tree (leaf root)
  w.u32(0x78ca8c91);
  w.u32(2); // blockSize
  w.u32(4); // keySize
  w.u32(8); // valSize
  w.u64(2); // itemCount
  w.u64(0);
  w.u8(1);
  w.u8(0);
  w.u16(2);
  w.str('chrA', 4);
  w.u32(0);
  w.u32(5000);
  w.str('chrB', 4);
  w.u32(1);
  w.u32(3000);
  assertEq(w.length, dataOffset);
  // data: item count + blocks
  w.u64(3);
  w.raw(blkA);
  w.raw(blkB);
  assertEq(w.length, rtreeOffset);
  // R-tree header
  w.u32(0x2468ace0);
  w.u32(256); // blockSize
  w.u64(3); // itemCount
  w.u32(0); // startChromIx
  w.u32(100);
  w.u32(1); // endChromIx
  w.u32(900);
  w.u64(rtreeOffset); // endFileOffset (unused by the reader)
  w.u32(64); // itemsPerSlot
  w.u32(0);
  // internal root with one child
  w.u8(0);
  w.u8(0);
  w.u16(1);
  w.u32(0);
  w.u32(100);
  w.u32(1);
  w.u32(900);
  w.u64(leafOffset);
  assertEq(w.length, leafOffset);
  // leaf with the two blocks
  w.u8(1);
  w.u8(0);
  w.u16(2);
  w.u32(0);
  w.u32(100);
  w.u32(0);
  w.u32(900);
  w.u64(blkAOff);
  w.u64(blkA.length);
  w.u32(1);
  w.u32(10);
  w.u32(1);
  w.u32(20);
  w.u64(blkBOff);
  w.u64(blkB.length);
  return new Uint8Array(w.bytes);
}

/** @param {Uint8Array} fixture */
function reader(fixture) {
  return new RemoteBigBed('mem://fixture', {
    fetchRange: async (s, e) => fixture.subarray(s, Math.min(e, fixture.length)),
  });
}

test('bigbed: chrom tree maps names to ids and sizes', async () => {
  const bb = reader(await buildFixture());
  const chroms = await bb.chroms();
  assertEq(chroms.get('chrA')?.id, 0);
  assertEq(chroms.get('chrA')?.size, 5000);
  assertEq(chroms.get('chrB')?.id, 1);
});

test('bigbed: query returns parsed BED9 items through the two-level R-tree', async () => {
  const bb = reader(await buildFixture());
  const items = await bb.query('chrA', 0, 1000);
  assertEq(items.length, 2);
  assertEq(items[0].name, 'alpha');
  assertEq(items[0].strand, '+');
  assertEq(items[0].rgb, '255,0,0');
  assertEq(items[1].name, 'beta');
  assertEq(items[1].start, 450);
});

test('bigbed: row-level overlap filtering inside a block', async () => {
  const bb = reader(await buildFixture());
  const items = await bb.query('chrA', 600, 700);
  assertEq(items.length, 1);
  assertEq(items[0].name, 'beta');
});

test('bigbed: other chromosomes and unknown names', async () => {
  const bb = reader(await buildFixture());
  assertEq((await bb.query('chrB', 0, 3000)).length, 1);
  assertEq((await bb.query('chrB', 100, 200)).length, 0);
  assertEq((await bb.query('chrC', 0, 100)).length, 0);
});

test('bigbed: bad magic throws', async () => {
  const bad = new Uint8Array(64);
  const bb = reader(bad);
  let threw = false;
  try {
    await bb.header();
  } catch {
    threw = true;
  }
  assert(threw, 'expected a throw');
});
