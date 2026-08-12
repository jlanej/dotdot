// @ts-check
import { test, assert, assertEq, mulberry32 } from './harness.js';
import { buildIndex, matchStrand, KMER_DEFAULTS } from '../js/core/kmer.js';
import { reverseComplement } from '../js/core/dna.js';
import { newSegmentVecs, vecsToSegments } from '../js/core/types.js';
import { assemblePool } from '../js/worker/assemble.js';

/** @param {number} n @param {number} seed */
function randCodes(n, seed) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 4) | 0;
  return out;
}

/** @param {number[]} lens */
function starts(lens) {
  const out = new Float64Array(lens.length + 1);
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    out[i] = acc;
    acc += lens[i];
  }
  out[lens.length] = acc;
  return out;
}

/** Same mirroring the coordinator applies (kept local: importing the worker
 * module would install its onmessage handler on the page).
 * @param {Float64Array} s */
function mirrorStarts(s) {
  const m = s.length - 1;
  const out = new Float64Array(m + 1);
  let acc = 0;
  for (let j = 0; j < m; j++) {
    out[j] = acc;
    acc += s[m - j] - s[m - j - 1];
  }
  out[m] = acc;
  return out;
}

/**
 * @param {Uint8Array} tCodes @param {Float64Array} tStarts
 * @param {Uint8Array} qCodes @param {Float64Array} qStarts
 * @param {import('../js/core/kmer.js').KmerOptions} opts
 */
function runSingle(tCodes, tStarts, qCodes, qStarts, opts) {
  const index = buildIndex(tCodes, tStarts, opts.k, opts.stride);
  const out = newSegmentVecs(64);
  const qTotal = qStarts[qStarts.length - 1];
  const tTotal = tStarts[tStarts.length - 1];
  matchStrand(index, qCodes, qStarts, qTotal, tStarts, tTotal, opts, 0, out);
  matchStrand(index, reverseComplement(qCodes), mirrorStarts(qStarts), qTotal, tStarts, tTotal, opts, 1, out);
  return vecsToSegments(out);
}

/**
 * Simulate the pool: chunked matchers with edge flags, then assembly.
 * @param {Uint8Array} tCodes @param {Float64Array} tStarts
 * @param {Uint8Array} qCodes @param {Float64Array} qStarts
 * @param {import('../js/core/kmer.js').KmerOptions} opts
 * @param {number} chunk
 */
function runPooled(tCodes, tStarts, qCodes, qStarts, opts, chunk) {
  const index = buildIndex(tCodes, tStarts, opts.k, opts.stride);
  const qTotal = qStarts[qStarts.length - 1];
  const tTotal = tStarts[tStarts.length - 1];
  const rc = reverseComplement(qCodes);
  const rcStarts = mirrorStarts(qStarts);
  /** @type {any[]} */
  const parts = [];
  for (let lo = 0; lo < qCodes.length; lo += chunk) {
    const hi = Math.min(qCodes.length, lo + chunk);
    const out = newSegmentVecs(64, true);
    matchStrand(index, qCodes, qStarts, qTotal, tStarts, tTotal, opts, 0, out, undefined, lo, hi);
    // Per-part rc mirroring, exactly as js/worker/match.js does it.
    matchStrand(index, rc, rcStarts, qTotal, tStarts, tTotal, opts, 1, out, undefined, qTotal - hi, qTotal - lo);
    const seg = /** @type {any} */ (vecsToSegments(out));
    seg.edge = /** @type {import('../js/core/vec.js').U8Vec} */ (out.edge).done();
    parts.push(seg);
  }
  const plan = { shared: { opts }, target: { starts: tStarts }, query: { starts: qStarts } };
  return assemblePool(plan, parts);
}

/** Order-independent fingerprint of a store. @param {import('../js/core/types.js').SegmentStore} s */
function canonical(s) {
  const rows = [];
  for (let i = 0; i < s.count; i++) {
    rows.push(`${s.x[i]}|${s.y[i]}|${s.dx[i]}|${s.strand[i]}|${s.identity[i].toFixed(4)}`);
  }
  return rows.sort().join('\n');
}

const OPTS = { ...KMER_DEFAULTS, k: 12, maxGap: 8, maxOcc: 200, minRunLen: 0, stride: 1, qSample: 1 };

test('assemble: chunked pool + stitching reproduces single-core exactly (forward)', () => {
  const t = randCodes(3000, 11);
  const q = t.slice();
  const single = runSingle(t, starts([3000]), q, starts([3000]), OPTS);
  const pooled = runPooled(t, starts([3000]), q, starts([3000]), OPTS, 700);
  // The 3000 bp identity diagonal is split at every 700 bp cut and must
  // come back as the one segment the single-core run emits.
  assertEq(pooled.segments.count, single.count);
  assertEq(canonical(pooled.segments), canonical(single));
});

test('assemble: reverse-strand runs stitch across mirrored cuts', () => {
  const t = randCodes(2600, 23);
  const q = reverseComplement(t);
  const single = runSingle(t, starts([2600]), q, starts([2600]), OPTS);
  const pooled = runPooled(t, starts([2600]), q, starts([2600]), OPTS, 600);
  assert(single.count > 0, 'expected a reverse diagonal');
  assertEq(pooled.segments.count, single.count);
  assertEq(canonical(pooled.segments), canonical(single));
});

test('assemble: minRunLen at chunk cuts drops nothing single-core keeps', () => {
  // Mutate every ~230th base so runs are a few hundred bp; a 300 bp chunk
  // then slices many runs into pieces shorter than minRunLen.
  const t = randCodes(4000, 5);
  const q = t.slice();
  for (let i = 137; i < q.length; i += 229) q[i] = (q[i] + 1) & 3;
  const opts = { ...OPTS, maxGap: 0, minRunLen: 100 };
  const single = runSingle(t, starts([4000]), q, starts([4000]), opts);
  const pooled = runPooled(t, starts([4000]), q, starts([4000]), opts, 300);
  assert(single.count > 5, 'fixture should produce several runs');
  assertEq(pooled.segments.count, single.count);
  assertEq(canonical(pooled.segments), canonical(single));
});

test('assemble: pieces never stitch across a record boundary', () => {
  // Target = one sequence split into two records; query = the same bases as
  // one record. The diagonal is numerically continuous across the target
  // boundary, but runs must stay split there — exactly like single-core.
  const whole = randCodes(2000, 47);
  const tStarts = starts([1000, 1000]);
  const qStarts = starts([2000]);
  const single = runSingle(whole, tStarts, whole.slice(), qStarts, OPTS);
  // Cut right at the record boundary so both sides emit edge-flagged pieces.
  const pooled = runPooled(whole, tStarts, whole.slice(), qStarts, OPTS, 1000);
  // The identity diagonal must stay split at the target record boundary:
  // exactly two 1000 bp forward segments (short rc-palindromic noise from
  // the random fixture may also appear — on both paths identically).
  let fullLen = 0;
  for (let i = 0; i < single.count; i++) {
    if (single.strand[i] === 0 && single.dx[i] === 1000) fullLen++;
  }
  assertEq(fullLen, 2);
  assertEq(pooled.segments.count, single.count);
  assertEq(canonical(pooled.segments), canonical(single));
});

test('assemble: sampled options stitch with the sampling gap credit', () => {
  const t = randCodes(6000, 91);
  const q = t.slice();
  const opts = { ...OPTS, qSample: 3, maxGap: 4 };
  const single = runSingle(t, starts([6000]), q, starts([6000]), opts);
  const pooled = runPooled(t, starts([6000]), q, starts([6000]), opts, 1100);
  assertEq(pooled.segments.count, single.count);
  assertEq(canonical(pooled.segments), canonical(single));
});
