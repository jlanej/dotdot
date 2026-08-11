// @ts-check
import { test, assert, assertEq } from './harness.js';
import { RemoteTwoBit, regionToFasta } from '../js/io/twobit.js';
import { parseFasta } from '../js/io/fasta.js';
import { codesToString } from '../js/core/dna.js';

const VAL = { T: 0, C: 1, A: 2, G: 3 };

/**
 * Build an in-memory 2bit file. N runs become N blocks; every sequence gets
 * a dummy mask block so the packed-DNA offset arithmetic is exercised.
 * @param {{name: string, seq: string}[]} seqs
 */
function buildTwoBit(seqs) {
  /** @type {number[]} */
  const bytes = [];
  const w32 = (/** @type {number} */ v) => {
    bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };
  w32(0x1a412743);
  w32(0);
  w32(seqs.length);
  w32(0);

  // index (offsets patched after layout)
  /** @type {number[]} */
  const patchAt = [];
  for (const s of seqs) {
    bytes.push(s.name.length);
    for (const ch of s.name) bytes.push(ch.charCodeAt(0));
    patchAt.push(bytes.length);
    w32(0);
  }

  seqs.forEach((s, si) => {
    const offset = bytes.length;
    const b = bytes;
    const at = patchAt[si];
    b[at] = offset & 0xff;
    b[at + 1] = (offset >>> 8) & 0xff;
    b[at + 2] = (offset >>> 16) & 0xff;
    b[at + 3] = (offset >>> 24) & 0xff;

    const seq = s.seq.toUpperCase();
    w32(seq.length);
    /** @type {[number, number][]} */
    const nBlocks = [];
    for (const m of seq.matchAll(/N+/g)) nBlocks.push([m.index ?? 0, m[0].length]);
    w32(nBlocks.length);
    for (const [st] of nBlocks) w32(st);
    for (const [, len] of nBlocks) w32(len);
    // one dummy mask block — reader must skip it arithmetically
    w32(1);
    w32(0);
    w32(Math.min(2, seq.length));
    w32(0); // reserved
    for (let i = 0; i < seq.length; i += 4) {
      let byte = 0;
      for (let j = 0; j < 4; j++) {
        const ch = seq[i + j] ?? 'T';
        const v = ch === 'N' ? 0 : VAL[/** @type {keyof typeof VAL} */ (ch)];
        byte |= v << ((3 - j) * 2);
      }
      bytes.push(byte);
    }
  });
  return new Uint8Array(bytes);
}

/** @param {Uint8Array} fixture */
function reader(fixture) {
  return new RemoteTwoBit('mem://fixture', {
    fetchRange: async (s, e) => fixture.subarray(s, Math.min(e, fixture.length)),
  });
}

const ALPHA = 'ACGTACGTNNNNACGTAC';
const BETA = 'TTTTCCCCAAAAGGGGT';
const FIXTURE = buildTwoBit([
  { name: 'alpha', seq: ALPHA },
  { name: 'beta', seq: BETA },
]);

test('twobit: index lists sequences in order', async () => {
  const tb = reader(FIXTURE);
  const names = await tb.names();
  assertEq(names.join(','), 'alpha,beta');
});

test('twobit: seqMeta reads sizes and N blocks', async () => {
  const tb = reader(FIXTURE);
  const meta = await tb.seqMeta('alpha');
  assertEq(meta.dnaSize, ALPHA.length);
  assertEq(meta.nBlocks.length, 1);
  assertEq(meta.nBlocks[0][0], 8);
  assertEq(meta.nBlocks[0][1], 4);
});

test('twobit: full-sequence fetch reproduces the input (N applied)', async () => {
  const tb = reader(FIXTURE);
  const a = new TextDecoder().decode(await tb.fetchRegion('alpha', 0, ALPHA.length));
  assertEq(a, ALPHA);
  const b = new TextDecoder().decode(await tb.fetchRegion('beta', 0, BETA.length));
  assertEq(b, BETA);
});

test('twobit: sub-regions at every byte phase', async () => {
  const tb = reader(FIXTURE);
  for (let start = 0; start < 6; start++) {
    for (const end of [start + 1, start + 5, ALPHA.length]) {
      const got = new TextDecoder().decode(await tb.fetchRegion('alpha', start, end));
      assertEq(got, ALPHA.slice(start, end), `alpha[${start},${end})`);
    }
  }
});

test('twobit: region partially overlapping an N block', async () => {
  const tb = reader(FIXTURE);
  const got = new TextDecoder().decode(await tb.fetchRegion('alpha', 6, 14));
  assertEq(got, ALPHA.slice(6, 14));
});

test('twobit: unknown sequence throws', async () => {
  const tb = reader(FIXTURE);
  let threw = false;
  try {
    await tb.fetchRegion('gamma', 0, 10);
  } catch {
    threw = true;
  }
  assert(threw, 'expected a throw');
});

test('twobit: regionToFasta round-trips through parseFasta with offsets', async () => {
  const tb = reader(FIXTURE);
  const bases = await tb.fetchRegion('beta', 4, 16);
  const fasta = regionToFasta('beta', 'test beta:5-16 @stuff', 4, bases);
  const parsed = parseFasta(fasta);
  assertEq(parsed.catalog.names[0], 'beta');
  assert(parsed.catalog.offsets !== undefined, 'offsets present');
  assertEq(/** @type {Float64Array} */ (parsed.catalog.offsets)[0], 4);
  assertEq(codesToString(parsed.codes), 'CCCCAAAAGGGG');
});
