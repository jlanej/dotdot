// @ts-check
import { test, assert, assertEq, mulberry32 } from './harness.js';
import {
  handleRequest,
  setPostForTesting,
  resetParsedCacheForTesting,
} from '../js/worker/compute.js';

const enc = new TextEncoder();

/** @param {string} name @param {string} seq */
function fastaBuf(name, seq) {
  return enc.encode(`>${name}\n${seq}\n`).buffer;
}

/** @param {number} n deterministic ACGT string */
function randSeq(n, seed = 42) {
  const rnd = mulberry32(seed);
  let s = '';
  for (let i = 0; i < n; i++) s += 'ACGT'[(rnd() * 4) | 0];
  return s;
}

/** Fresh capture per case: cold cache + a message log. */
function rig() {
  resetParsedCacheForTesting();
  /** @type {any[]} */
  const msgs = [];
  setPostForTesting((m) => msgs.push(m));
  /** @param {string} type */
  const of = (type) => msgs.filter((m) => m.type === type);
  return { msgs, of };
}

test('compute: needData protocol — miss asks, buffers fill, options-only reuses', async () => {
  const { of } = rig();
  const seq = randSeq(2000);
  // Cold cache, no buffers: the worker must ask, not guess.
  await handleRequest({ id: 1, type: 'kmer', gen: 7, target: null, query: null, opts: {} });
  assertEq(of('needData').length, 1);
  assertEq(of('needData')[0].gen, 7);
  assertEq(of('result').length, 0);
  // Buffers arrive: parse, cache, compute.
  await handleRequest({
    id: 2, type: 'kmer', gen: 7, target: fastaBuf('t', seq), query: null, opts: {},
  });
  assertEq(of('result').length, 1);
  assert(of('result')[0].data.segments.count > 0, 'self-plot matches exist');
  // Same generation, options-only: served from the cache — no second ask.
  await handleRequest({ id: 3, type: 'kmer', gen: 7, target: null, query: null, opts: {} });
  assertEq(of('needData').length, 1);
  assertEq(of('result').length, 2);
});

test('compute: exact-mode consent fires over the ceiling and honors the confirmed resubmit', async () => {
  const { of } = rig();
  const seq = randSeq(2000);
  // A deliberately tiny ceiling makes the gate testable at test scale: the
  // ask must carry the real numbers, and nothing may compute yet.
  const opts = { sample: 'off', exactMaxBp: 1000 };
  await handleRequest({ id: 1, type: 'kmer', gen: 1, target: fastaBuf('t', seq), query: null, opts });
  assertEq(of('confirmExact').length, 1);
  const ask = of('confirmExact')[0];
  assertEq(ask.tLenBp, 2000);
  assert(ask.gbLo > 0 && ask.gbHi > ask.gbLo, 'RAM estimate travels with the ask');
  assertEq(of('result').length, 0);
  // The consent click resubmits options-only with the flag — cache is warm.
  await handleRequest({
    id: 2, type: 'kmer', gen: 1, target: null, query: null,
    opts: { ...opts, exactConfirmed: true },
  });
  assertEq(of('result').length, 1);
  assertEq(of('needData').length, 0);
});

test('compute: the anchor-volume pre-flight predicts the quadratic grind before matching', async () => {
  const { of } = rig();
  // 100 kb of one repeated k-mer: one group of ~1e5 entries → occ² ≈ 1e10
  // anchor pairs at scale 1 — a REAL quadratic satellite, at test size.
  const polyA = 'A'.repeat(100_000);
  await handleRequest({
    id: 1, type: 'kmer', gen: 1, target: fastaBuf('sat', polyA), query: null,
    opts: { maxOcc: Infinity, budgetX: Infinity },
  });
  assertEq(of('confirmVolume').length, 1);
  const ask = of('confirmVolume')[0];
  assert(ask.estAnchors > 2e9, `predicted the grind: ${ask.estAnchors}`);
  assertEq(ask.estUpper, false); // cap off = the estimate is not tail-inflated
  assertEq(ask.tLenBp, 100_000);
  assertEq(of('result').length, 0); // asked BEFORE the minutes, not after
});

test('compute: a finite cap past the histogram tail marks the estimate an upper bound', async () => {
  const { of } = rig();
  const polyA = 'A'.repeat(100_000);
  await handleRequest({
    id: 1, type: 'kmer', gen: 1, target: fastaBuf('sat', polyA), query: null,
    opts: { maxOcc: 5000, budgetX: Infinity },
  });
  assertEq(of('confirmVolume').length, 1);
  assertEq(of('confirmVolume')[0].estUpper, true);
});

test('compute: a PAF handed to a FASTA slot is named, not parsed into an empty plot', async () => {
  const { of } = rig();
  const paf = 'q1\t1000\t100\t200\t+\tt1\t2000\t500\t600\t95\t100\t60\n';
  await handleRequest({
    id: 1, type: 'kmer', gen: 1, target: enc.encode(paf).buffer, query: null, opts: {},
  });
  assertEq(of('error').length, 1);
  assert(of('error')[0].message.includes('looks like a PAF alignment file'), of('error')[0].message);
});

test('compute: parser warnings ride the result note', async () => {
  const { of } = rig();
  const seq = randSeq(300, 7);
  await handleRequest({
    id: 1, type: 'kmer', gen: 1,
    target: [fastaBuf('chr1', seq), fastaBuf('chr1', randSeq(300, 8))],
    query: null, opts: {},
  });
  assertEq(of('result').length, 1);
  const note = of('result')[0].data.stats.note ?? '';
  assert(note.includes('duplicate sequence names'), `note discloses the ambiguity: "${note}"`);
});

test('compute: belongs matrix — needData protocol, then exact containment', async () => {
  const { of } = rig();
  const seq = randSeq(1500, 61);
  const fa = `>a\n${seq}\n>b\n${seq}\n`;
  // Cold cache asks for data instead of guessing.
  await handleRequest({ id: 1, type: 'belongs', gen: 3, target: null, query: null, opts: { k: 15 } });
  assertEq(of('needData').length, 1);
  await handleRequest({
    id: 2, type: 'belongs', gen: 3, target: enc.encode(fa).buffer, query: null, opts: { k: 15 },
  });
  assertEq(of('belongsResult').length, 1);
  const m = of('belongsResult')[0];
  assertEq(m.nR, 2);
  assertEq(m.nRecT, 2);
  assertEq(m.scaled, 1, 'tiny input scans exact');
  assertEq(m.tot[0], 1500 - 14);
  assertEq(m.shared[0 * 2 + 1], m.tot[0], 'duplicate records fully contained');
  // Options-only follow-up rides the caches — no second ask.
  await handleRequest({ id: 3, type: 'belongs', gen: 3, target: null, query: null, opts: { k: 15 } });
  assertEq(of('needData').length, 1);
  assertEq(of('belongsResult').length, 2);
});

test('compute: belongs gather — record-local coordinates, cross-plot record order', async () => {
  const { of } = rig();
  const x = randSeq(3000, 62);
  const y = randSeq(3000, 63);
  const q = x.slice(500, 1500) + y.slice(1000, 2000);
  await handleRequest({
    id: 1, type: 'belongs', gen: 4,
    target: enc.encode(`>x\n${x}\n>y\n${y}\n`).buffer,
    query: enc.encode(`>q\n${q}\n`).buffer,
    opts: { k: 15, rec: 2 },
  });
  assertEq(of('belongsGather').length, 1);
  const g = of('belongsGather')[0];
  assertEq(g.rec, 2);
  assertEq(g.totMass, 2000 - 14);
  assertEq(g.components.length, 2, `two source windows, got ${g.components.length}`);
  for (const c of g.components) {
    assert(c.rec === 0 || c.rec === 1, 'components land in target records');
    assert(c.lo >= 0 && c.hi <= 3000, `record-local coords, got [${c.lo}, ${c.hi})`);
    const want = c.rec === 0 ? [500, 1500] : [1000, 2000];
    assert(c.lo <= want[0] && c.hi >= want[1], `window covers the source span (rec ${c.rec})`);
  }
});

test('compute: belongs refuses a single lonely record with guidance', async () => {
  const { of } = rig();
  await handleRequest({
    id: 1, type: 'belongs', gen: 5,
    target: fastaBuf('only', randSeq(1000, 64)), query: null, opts: { k: 15 },
  });
  assertEq(of('error').length, 1);
  assert(of('error')[0].message.includes('multi-sequence FASTA'), of('error')[0].message);
});
