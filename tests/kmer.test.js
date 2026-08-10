// @ts-check
import { test, assert, assertEq, assertClose, mulberry32 } from './harness.js';
import { buildIndex, matchStrand, KMER_DEFAULTS } from '../js/core/kmer.js';
import { reverseComplement } from '../js/core/dna.js';
import { F64Vec, F32Vec, U8Vec } from '../js/core/vec.js';

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

function makeOut() {
  return {
    x: new F64Vec(16),
    y: new F64Vec(16),
    dx: new F32Vec(16),
    dy: new F32Vec(16),
    strand: new U8Vec(16),
    identity: new F32Vec(16),
  };
}

/**
 * @param {Uint8Array} tCodes @param {Float64Array} tStarts
 * @param {Uint8Array} qCodes @param {Float64Array} qStarts
 * @param {Partial<import('../js/core/kmer.js').KmerOptions>} [optsIn]
 */
function match(tCodes, tStarts, qCodes, qStarts, optsIn) {
  const opts = { ...KMER_DEFAULTS, maxGap: 0, ...optsIn };
  const index = buildIndex(tCodes, tStarts, opts.k, opts.stride);
  const out = makeOut();
  const qTotal = qStarts[qStarts.length - 1];
  const tTotal = tStarts[tStarts.length - 1];
  matchStrand(index, qCodes, qStarts, qTotal, tStarts, tTotal, opts, 0, out);
  const rc = reverseComplement(qCodes);
  // single-record queries: mirrored starts equal the original
  matchStrand(index, rc, qStarts, qTotal, tStarts, tTotal, opts, 1, out);
  const segs = [];
  for (let i = 0; i < out.x.n; i++) {
    segs.push({
      x: out.x.a[i],
      y: out.y.a[i],
      len: out.dx.a[i],
      strand: out.strand.a[i],
      identity: out.identity.a[i],
    });
  }
  return segs;
}

test('kmer: exact forward substring merges into one run', () => {
  const t = randCodes(500, 1);
  const q = t.slice(100, 200);
  const segs = match(t, starts([500]), q, starts([100]));
  assertEq(segs.length, 1);
  assertEq(segs[0].x, 100);
  assertEq(segs[0].y, 0);
  assertEq(segs[0].len, 100);
  assertEq(segs[0].strand, 0);
  assertClose(segs[0].identity, 1, 1e-6);
});

test('kmer: reverse-complement substring maps back to original coords', () => {
  const t = randCodes(500, 2);
  const q = reverseComplement(t.slice(100, 200));
  const segs = match(t, starts([500]), q, starts([100]));
  assertEq(segs.length, 1);
  assertEq(segs[0].strand, 1);
  assertEq(segs[0].x, 100);
  assertEq(segs[0].y, 0);
  assertEq(segs[0].len, 100);
});

test('kmer: one SNP splits runs at maxGap 0 and bridges at maxGap 16', () => {
  const t = randCodes(400, 3);
  const q = t.slice(100, 200);
  q[50] = (q[50] + 1) & 3;
  const split = match(t, starts([400]), q, starts([100]), { maxGap: 0 });
  assertEq(split.filter((s) => s.strand === 0).length, 2);
  const bridged = match(t, starts([400]), q, starts([100]), { maxGap: 16 });
  const fwd = bridged.filter((s) => s.strand === 0);
  assertEq(fwd.length, 1);
  assertEq(fwd[0].len, 100);
  // one 15-base hole (positions covered only by SNP-crossing k-mers)
  assertClose(fwd[0].identity, (100 - 15) / 100, 1e-6);
});

test('kmer: N breaks matching', () => {
  const t = randCodes(200, 4);
  const q = t.slice(50, 150);
  q[40] = 4; // N
  const segs = match(t, starts([200]), q, starts([100]), { maxGap: 0 });
  assertEq(segs.filter((s) => s.strand === 0).length, 2);
});

test('kmer: gap bridging never crosses a record boundary', () => {
  // chrA-tail and chrB sit on the same global diagonal — exactly the layout
  // that once produced a bogus 443 kb cross-sequence merge in the demo.
  const a = randCodes(150, 21);
  const b = randCodes(180, 22);
  const t = new Uint8Array(330);
  t.set(a, 0);
  t.set(b, 150);
  const q = t.slice();
  // Same records on the query axis too, same diagonal, generous bridging:
  const segs = match(t, starts([150, 180]), q, starts([150, 180]), { maxGap: 256 });
  const fwd = segs.filter((s) => s.strand === 0);
  assertEq(fwd.length, 2);
  fwd.sort((p, q2) => p.x - q2.x);
  assertEq(fwd[0].x, 0);
  assertEq(fwd[0].len, 150);
  assertEq(fwd[1].x, 150);
  assertEq(fwd[1].len, 180);
});

test('kmer: record boundaries stop k-mer windows', () => {
  const a = randCodes(120, 5);
  const b = randCodes(140, 6);
  const t = new Uint8Array(260);
  t.set(a, 0);
  t.set(b, 120);
  // query = same concatenation but as ONE record
  const segs = match(t, starts([120, 140]), t.slice(), starts([260]), { maxGap: 0 });
  const fwd = segs.filter((s) => s.strand === 0);
  assertEq(fwd.length, 2);
  fwd.sort((p, q2) => p.x - q2.x);
  assertEq(fwd[0].x, 0);
  assertEq(fwd[0].len, 120);
  assertEq(fwd[1].x, 120);
  assertEq(fwd[1].y, 120);
  assertEq(fwd[1].len, 140);
});

test('kmer: maxOcc suppresses repeat explosions', () => {
  // 60 tandem copies of a 20-mer: every query k-mer occurs ~60x in target
  const unit = randCodes(20, 7);
  const t = new Uint8Array(20 * 60);
  for (let i = 0; i < 60; i++) t.set(unit, i * 20);
  const q = unit.slice();
  const capped = match(t, starts([1200]), q, starts([20]), { maxOcc: 20 });
  assertEq(capped.length, 0);
  const open = match(t, starts([1200]), q, starts([20]), { maxOcc: 100 });
  assert(open.length > 50, `expected many segments, got ${open.length}`);
});

test('kmer: minRunLen drops short matches', () => {
  const t = randCodes(600, 8);
  const q = new Uint8Array(220);
  q.set(t.slice(100, 200), 0); // 100 bp match
  q.set(randCodes(100, 9), 100);
  q.set(t.slice(400, 420), 200); // 20 bp match (single k-mer runs)
  const all = match(t, starts([600]), q, starts([220]), { minRunLen: 0 });
  const long = match(t, starts([600]), q, starts([220]), { minRunLen: 50 });
  assert(all.length >= 2, 'both matches present unfiltered');
  assertEq(long.filter((s) => s.strand === 0).length, 1);
  assertEq(long[0].len, 100);
});

test('kmer: self-match produces the main diagonal per record', () => {
  const t = randCodes(300, 10);
  const segs = match(t, starts([300]), t.slice(), starts([300]), { maxGap: 0 });
  const diag = segs.filter((s) => s.strand === 0 && s.x === 0 && s.y === 0);
  assertEq(diag.length, 1);
  assertEq(diag[0].len, 300);
});

test('kmer: stride subsampling still finds the diagonal', () => {
  const t = randCodes(2000, 11);
  const q = t.slice(500, 1500);
  const segs = match(t, starts([2000]), q, starts([1000]), { stride: 4, maxGap: 8 });
  const fwd = segs.filter((s) => s.strand === 0);
  assert(fwd.length >= 1, 'diagonal found');
  const covered = fwd.reduce((acc, s) => acc + s.len, 0);
  assert(covered > 900, `stride coverage too low: ${covered}`);
});

test('kmer: range-partitioned matching tiles seamlessly', () => {
  const t = randCodes(600, 30);
  const q = t.slice(100, 500); // one 400 bp match
  const opts = { ...KMER_DEFAULTS, maxGap: 0 };
  const index = buildIndex(t, starts([600]), opts.k, 1);
  const qs = starts([400]);
  const out = makeOut();
  // two disjoint ranges covering the query
  matchStrand(index, q, qs, 400, starts([600]), 600, opts, 0, out, undefined, 0, 200);
  matchStrand(index, q, qs, 400, starts([600]), 600, opts, 0, out, undefined, 200, 400);
  assertEq(out.x.n, 2);
  const seg = (i) => ({ x: out.x.a[i], y: out.y.a[i], len: out.dx.a[i] });
  const a = seg(0);
  const b = seg(1);
  const [first, second] = a.y < b.y ? [a, b] : [b, a];
  // first run ends at the cut (+k-1 window tail), second starts exactly at it
  assertEq(first.x, 100);
  assertEq(first.y, 0);
  assertEq(first.len, 199 + opts.k);
  assertEq(second.x, 300);
  assertEq(second.y, 200);
  assertEq(second.len, 200);
});

test('kmer: k=16 packs into 32 bits without collisions breaking coords', () => {
  const t = randCodes(400, 12);
  const q = t.slice(50, 350);
  const segs = match(t, starts([400]), q, starts([300]), { k: 16 });
  assertEq(segs.filter((s) => s.strand === 0).length, 1);
  assertEq(segs[0].x, 50);
  assertEq(segs[0].len, 300);
});

test('kmer: wide k (17..26) matches exactly on both strands', () => {
  for (const k of [17, 21, 26]) {
    const t = randCodes(600, 40 + k);
    const q = t.slice(120, 420);
    const fwd = match(t, starts([600]), q, starts([300]), { k });
    const f = fwd.filter((s) => s.strand === 0);
    assertEq(f.length, 1, `k=${k} forward count`);
    assertEq(f[0].x, 120, `k=${k} x`);
    assertEq(f[0].y, 0, `k=${k} y`);
    assertEq(f[0].len, 300, `k=${k} len`);

    const qr = reverseComplement(t.slice(200, 500));
    const rev = match(t, starts([600]), qr, starts([300]), { k });
    const r = rev.filter((s) => s.strand === 1);
    assertEq(r.length, 1, `k=${k} reverse count`);
    assertEq(r[0].x, 200, `k=${k} rev x`);
    assertEq(r[0].len, 300, `k=${k} rev len`);
  }
});

test('kmer: wide k respects record boundaries and gap bridging', () => {
  const a = randCodes(200, 61);
  const b = randCodes(220, 62);
  const t = new Uint8Array(420);
  t.set(a, 0);
  t.set(b, 200);
  const segs = match(t, starts([200, 220]), t.slice(), starts([200, 220]), { k: 21, maxGap: 256 });
  const fwd = segs.filter((s) => s.strand === 0);
  assertEq(fwd.length, 2);
  fwd.sort((p, q2) => p.x - q2.x);
  assertEq(fwd[0].len, 200);
  assertEq(fwd[1].len, 220);
});
