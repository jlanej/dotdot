// @ts-check
/**
 * Remote bigBed reader — UCSC's indexed annotation format, read the same way
 * the 2bit streamer works: byte-range requests fetch only what a query
 * needs. A region query costs the 64-byte header + the chromosome B+ tree
 * once, then an R-tree walk plus the few kilobytes of zlib blocks that
 * overlap the window; the track itself never downloads.
 *
 * Layout (little-endian, version 3/4):
 *   header:  magic 0x8789F2EB, version, zoomLevels, chromTreeOffset,
 *            fullDataOffset, fullIndexOffset, fieldCount, definedFieldCount,
 *            autoSqlOffset, totalSummaryOffset, uncompressBufSize, reserved
 *   chrom B+ tree: magic 0x78CA8C91 — name -> (id, size)
 *   R-tree:  magic 0x2468ACE0 — (chromId, range) -> data blocks
 *   blocks:  zlib-deflated rows of (chromId u32, start u32, end u32,
 *            NUL-terminated tab-separated remaining BED fields)
 */
import { makeRangeFetcher } from './ranged.js';

const HEADER_MAGIC = 0x8789f2eb;
const CHROM_TREE_MAGIC = 0x78ca8c91;
const RTREE_MAGIC = 0x2468ace0;

/**
 * @typedef {Object} BedItem
 * @property {number} start 0-based chromosome coordinate
 * @property {number} end   exclusive
 * @property {string} name
 * @property {string} strand '+', '-', or ''
 * @property {string | null} rgb "r,g,b" itemRgb when the track carries one
 */

/** @param {Uint8Array} b */
function view(b) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** Inflate one zlib-wrapped block via the native stream. @param {Uint8Array} b */
async function inflate(b) {
  const plain = /** @type {Uint8Array<ArrayBuffer>} */ (b);
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class RemoteBigBed {
  /**
   * @param {string} url
   * @param {{fetchRange?: (start: number, endEx: number) => Promise<Uint8Array>}} [io]
   *   injectable transport (tests provide an in-memory fixture)
   */
  constructor(url, io = {}) {
    this.url = url;
    this.fetchRange = io.fetchRange ?? makeRangeFetcher(url);
    /** @type {{chromTreeOffset:number, fullIndexOffset:number, fieldCount:number, definedFieldCount:number, uncompressBufSize:number} | null} */
    this.head = null;
    /** @type {Map<string, {id: number, size: number}> | null} */
    this.chromMap = null;
  }

  async header() {
    if (this.head) return this.head;
    const b = await this.fetchRange(0, 64);
    const dv = view(b);
    if (dv.getUint32(0, true) !== HEADER_MAGIC) {
      throw new Error('Not a little-endian bigBed file (bad signature).');
    }
    this.head = {
      chromTreeOffset: Number(dv.getBigUint64(8, true)),
      fullIndexOffset: Number(dv.getBigUint64(24, true)),
      fieldCount: dv.getUint16(32, true),
      definedFieldCount: dv.getUint16(34, true),
      uncompressBufSize: dv.getUint32(52, true),
    };
    return this.head;
  }

  /** Chromosome name -> {id, size}, walking the B+ tree (cached). */
  async chroms() {
    if (this.chromMap) return this.chromMap;
    const head = await this.header();
    const hb = await this.fetchRange(head.chromTreeOffset, head.chromTreeOffset + 32);
    const hdv = view(hb);
    if (hdv.getUint32(0, true) !== CHROM_TREE_MAGIC) {
      throw new Error('Corrupt bigBed chromosome tree.');
    }
    const keySize = hdv.getUint32(8, true);
    /** @type {Map<string, {id: number, size: number}>} */
    const map = new Map();
    const td = new TextDecoder();
    const itemBytes = keySize + 8;
    /** @param {number} off */
    const walk = async (off) => {
      const nh = await this.fetchRange(off, off + 4);
      const isLeaf = nh[0] === 1;
      const count = view(nh).getUint16(2, true);
      const body = await this.fetchRange(off + 4, off + 4 + count * (isLeaf ? itemBytes : keySize + 8));
      const bdv = view(body);
      for (let i = 0; i < count; i++) {
        const p = i * (isLeaf ? itemBytes : keySize + 8);
        if (isLeaf) {
          const raw = body.subarray(p, p + keySize);
          let z = raw.indexOf(0);
          if (z < 0) z = keySize;
          const name = td.decode(raw.subarray(0, z));
          map.set(name, { id: bdv.getUint32(p + keySize, true), size: bdv.getUint32(p + keySize + 4, true) });
        } else {
          await walk(Number(bdv.getBigUint64(p + keySize, true)));
        }
      }
    };
    await walk(head.chromTreeOffset + 32);
    this.chromMap = map;
    return map;
  }

  /**
   * All items overlapping [start, end) of a chromosome.
   * @param {string} chrom @param {number} start @param {number} end
   * @returns {Promise<BedItem[]>}
   */
  async query(chrom, start, end) {
    const head = await this.header();
    const chroms = await this.chroms();
    const c = chroms.get(chrom);
    if (!c) return [];

    // R-tree walk: collect the data blocks whose bounds overlap the window.
    /** @type {{offset: number, size: number}[]} */
    const blocks = [];
    const rHead = await this.fetchRange(head.fullIndexOffset, head.fullIndexOffset + 48);
    if (view(rHead).getUint32(0, true) !== RTREE_MAGIC) {
      throw new Error('Corrupt bigBed index.');
    }
    /**
     * @param {number} sCix @param {number} sB @param {number} eCix @param {number} eB
     */
    const overlaps = (sCix, sB, eCix, eB) => {
      if (eCix < c.id || (eCix === c.id && eB <= start)) return false;
      if (sCix > c.id || (sCix === c.id && sB >= end)) return false;
      return true;
    };
    /** @param {number} off */
    const walk = async (off) => {
      const nh = await this.fetchRange(off, off + 4);
      const isLeaf = nh[0] === 1;
      const count = view(nh).getUint16(2, true);
      const itemBytes = isLeaf ? 32 : 24;
      const body = await this.fetchRange(off + 4, off + 4 + count * itemBytes);
      const bdv = view(body);
      for (let i = 0; i < count; i++) {
        const p = i * itemBytes;
        const sCix = bdv.getUint32(p, true);
        const sB = bdv.getUint32(p + 4, true);
        const eCix = bdv.getUint32(p + 8, true);
        const eB = bdv.getUint32(p + 12, true);
        if (!overlaps(sCix, sB, eCix, eB)) continue;
        if (isLeaf) {
          blocks.push({ offset: Number(bdv.getBigUint64(p + 16, true)), size: Number(bdv.getBigUint64(p + 24, true)) });
        } else {
          await walk(Number(bdv.getBigUint64(p + 16, true)));
        }
      }
    };
    await walk(head.fullIndexOffset + 48);
    if (blocks.length === 0) return [];

    // Coalesce nearby blocks into single ranged fetches.
    blocks.sort((a, b) => a.offset - b.offset);
    /** @type {{offset: number, end: number, parts: {offset: number, size: number}[]}[]} */
    const runs = [];
    for (const blk of blocks) {
      const last = runs[runs.length - 1];
      if (last && blk.offset - last.end < 65_536) {
        last.end = Math.max(last.end, blk.offset + blk.size);
        last.parts.push(blk);
      } else {
        runs.push({ offset: blk.offset, end: blk.offset + blk.size, parts: [blk] });
      }
    }

    /** @type {BedItem[]} */
    const items = [];
    const td = new TextDecoder();
    const defined = head.definedFieldCount;
    for (const run of runs) {
      const bytes = await this.fetchRange(run.offset, run.end);
      for (const blk of run.parts) {
        const raw = bytes.subarray(blk.offset - run.offset, blk.offset - run.offset + blk.size);
        const data = head.uncompressBufSize > 0 ? await inflate(raw) : raw;
        const dv = view(data);
        let p = 0;
        while (p + 12 <= data.length) {
          const cid = dv.getUint32(p, true);
          const s = dv.getUint32(p + 4, true);
          const e = dv.getUint32(p + 8, true);
          p += 12;
          let z = data.indexOf(0, p);
          if (z < 0) z = data.length;
          if (cid === c.id && s < end && e > start) {
            const rest = td.decode(data.subarray(p, z)).split('\t');
            items.push({
              start: s,
              end: e,
              name: defined >= 4 ? (rest[0] ?? '') : '',
              strand: defined >= 6 ? (rest[2] ?? '') : '',
              rgb: defined >= 9 && rest[5] ? rest[5] : null,
            });
          }
          p = z + 1;
        }
      }
    }
    items.sort((a, b) => a.start - b.start);
    return items;
  }
}
