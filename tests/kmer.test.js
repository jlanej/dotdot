// @ts-check
import { test, assert, assertEq, assertClose, mulberry32 } from './harness.js';
import { buildIndex, matchStrand, pickMaxOcc, pickDensity, estimateAnchors, saturatedIntervals, spliceIntervals, multiplicityProfile, containmentGrid, KMER_DEFAULTS } from '../js/core/kmer.js';
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

test('kmer: range-restricted index covers only its window, in global coords', () => {
  const t = randCodes(600, 70);
  const opts = { ...KMER_DEFAULTS, maxGap: 0 };
  // index only target [200, 400)
  const index = buildIndex(t, starts([600]), opts.k, 1, undefined, 200, 400);
  const qTotal = 600;
  const out = makeOut();
  matchStrand(index, t.slice(), starts([600]), qTotal, starts([600]), 600, opts, 0, out);
  // the self-match against a windowed index is exactly the window's diagonal
  assertEq(out.x.n, 1);
  assertEq(out.x.a[0], 200);
  assertEq(out.y.a[0], 200);
  assertEq(out.dx.a[0], 200 - 1 + opts.k); // starts 200..399 → covers 200..399+k-1
  // sequence outside the window finds nothing
  const out2 = makeOut();
  matchStrand(index, t.slice(0, 150), starts([150]), 150, starts([600]), 600, opts, 0, out2);
  assertEq(out2.x.n, 0);
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
  const seg = (/** @type {number} */ i) => ({ x: out.x.a[i], y: out.y.a[i], len: out.dx.a[i] });
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

test('kmer: pickMaxOcc scales the anchor budget by index stride', () => {
  /** @param {number} stride */
  const mk = (stride) => {
    const occSumSq = new Float64Array(1025);
    for (let o = 1; o <= 10; o++) occSumSq[o] = 4e6;
    return /** @type {import('../js/core/kmer.js').KmerIndex} */ (
      /** @type {any} */ ({ occSumSq, stride })
    );
  };
  const budget = 30e6;
  // Per-class anchor add is 4e6 at stride 1, 8e6 at stride 2: the same
  // histogram must pick a tighter cutoff when entries stand for 2× bases.
  assertEq(pickMaxOcc(mk(1), 1e6, 1e6, 1, 10, budget), 7);
  assertEq(pickMaxOcc(mk(2), 1e6, 1e6, 1, 10, budget), 4);
  // Index objects without a stride field behave as stride 1.
  const legacy = /** @type {any} */ ({ occSumSq: mk(1).occSumSq });
  assertEq(pickMaxOcc(legacy, 1e6, 1e6, 1, 10, budget), 7);
});

test('kmer: buildIndex records its stride', () => {
  const t = randCodes(4000, 77);
  assertEq(buildIndex(t, starts([4000]), 12, 3).stride, 3);
});

test('kmer: saturatedIntervals marks the over-cap repeat block, not the unique flanks', () => {
  // 2kb random | 2kb of ACAC... (period 2: every k-mer is one of two, each
  // occurring ~2000× — the unenumerable case) | 2kb random.
  const t = new Uint8Array(6144);
  t.set(randCodes(2048, 11), 0);
  for (let i = 2048; i < 4096; i++) t[i] = i % 2 === 0 ? 0 : 1; // A/C alternation
  t.set(randCodes(2048, 12), 4096);
  const index = buildIndex(t, starts([6144]), 8, 1);
  const sat = saturatedIntervals(index, 64, 6144, 512);
  assertEq(sat.length, 2);
  assertEq(sat[0], 2048);
  assertEq(sat[1], 4096);
  // A cap above the repeat's occurrence count saturates nothing.
  assertEq(saturatedIntervals(index, 4096, 6144, 512).length, 0);
});

test('kmer: spliceIntervals truncates at the window and inserts the replacement', () => {
  const existing = Float64Array.from([100, 200, 300, 500, 800, 900]);
  const out = spliceIntervals(existing, 150, 850, Float64Array.from([400, 450]));
  assertEq(Array.from(out).join(','), '100,150,400,450,850,900');
  // An empty replacement de-saturates the window entirely.
  assertEq(spliceIntervals(out, 0, 1000, new Float64Array(0)).length, 0);
  // Touching pieces merge.
  const merged = spliceIntervals(Float64Array.from([0, 100]), 100, 200, Float64Array.from([100, 150]));
  assertEq(Array.from(merged).join(','), '0,150');
});

test('kmer: occ cap 1 on a self-plot — forward off-diagonals impossible, inverted pairs pass', () => {
  // The user-discovered probe: self-plot at cap 1. Forward: any off-diagonal
  // match needs the k-mer twice on the forward strand -> occ 2 -> skipped
  // (the diagonal itself splits where the duplicated k-mers were skipped).
  const dupT = randCodes(600, 31);
  dupT.set(dupT.slice(100, 160), 400); // same segment, same strand, twice
  const dup = match(dupT, starts([600]), dupT.slice(), starts([600]), { maxOcc: 1, maxGap: 0 });
  assertEq(dup.filter((s) => s.strand === 0 && s.x !== s.y).length, 0);
  assert(dup.filter((s) => s.strand === 0).length >= 2, 'diagonal split around the skipped dup');

  // But the cap counts FORWARD occurrences only: a k-mer unique forward whose
  // reverse complement is also unique forward passes cap 1 on both lookups —
  // unique inverted pairs still draw, as reverse off-diagonals.
  const invT = randCodes(600, 32);
  invT.set(reverseComplement(invT.slice(100, 160)), 400);
  const inv = match(invT, starts([600]), invT.slice(), starts([600]), { maxOcc: 1, maxGap: 0 });
  assertEq(inv.filter((s) => s.strand === 0 && s.x !== s.y).length, 0);
  const rev = inv.filter((s) => s.strand === 1).sort((a, b) => a.x - b.x);
  assertEq(rev.length, 2); // the pair and its mirror
  assertEq(rev[0].x, 100);
  assertEq(rev[0].y, 400);
  assertEq(rev[1].x, 400);
  assertEq(rev[1].y, 100);
  assertEq(rev[0].len, 60);
});

test('kmer: multiplicityProfile maps repeat depth and unique territory', () => {
  const t = new Uint8Array(6144);
  t.set(randCodes(2048, 41), 0);
  for (let i = 2048; i < 4096; i++) t[i] = i % 2 === 0 ? 0 : 1; // deep AC repeat
  t.set(randCodes(2048, 42), 4096);
  const prof = multiplicityProfile(buildIndex(t, starts([6144]), 8, 1), 6144, 512);
  assertEq(prof.mult.length, 12);
  // Unique flank: ~1x, almost all k-mers unique.
  assert(prof.mult[0] < 1.2, `flank mult ${prof.mult[0]}`);
  assert(prof.uniqFrac[0] > 0.9, `flank uniq ${prof.uniqFrac[0]}`);
  // Repeat core: ~1000x, nothing unique.
  assert(prof.mult[5] > 500, `core mult ${prof.mult[5]}`);
  assertEq(prof.uniqFrac[5], 0);
  // Stride bias guard: unique sequence sampled 1/2 still reads ~1x, not 2x
  // (copy estimate is (occ-1)*stride + 1).
  const strided = multiplicityProfile(buildIndex(t, starts([6144]), 8, 2), 6144, 512);
  assert(strided.mult[0] < 1.2, `strided flank mult ${strided.mult[0]}`);
});

test('kmer: pickDensity — off is true full density, guarded; auto/number stride the target', () => {
  // 'off': both axes exact, regardless of size (under the ceiling).
  const exact = pickDensity('off', 1, 51_300_000, 51_300_000);
  assertEq(exact.stride, 1);
  assertEq(exact.qSample, 1);
  // Over the ceiling it refuses with guidance rather than silently striding.
  let threw = '';
  try { pickDensity('off', 1, 248_000_000, 248_000_000); } catch (e) { threw = String(e); }
  assert(threw.includes('128'), `expected ceiling in message, got: ${threw}`);
  // 'auto' and explicit numbers keep the 48 Mb index budget: target strides.
  const auto = pickDensity('auto', 1, 51_300_000, 51_300_000);
  assertEq(auto.stride, 2);
  assertEq(auto.qSample, 2);
  const pinned = pickDensity(1, 1, 51_300_000, 51_300_000);
  assertEq(pinned.stride, 2); // the old "full density" — query-side only
  assertEq(pinned.qSample, 1);
  // User stride floor is honored outside exact mode.
  assertEq(pickDensity('auto', 4, 1_000_000, 1_000_000).stride, 4);
});

test('kmer: pickDensity exact ceiling is user-raisable, clamped to the engine limit', () => {
  // 248 Mb refuses at the default ceiling, and the message teaches the raise.
  let msg = '';
  try { pickDensity('off', 1, 248_000_000, 248_000_000); } catch (e) { msg = String(e); }
  assert(msg.includes('off 248M'), `refusal should teach the override, got: ${msg}`);
  assert(msg.includes('GB'), 'refusal should estimate RAM');
  // A raised ceiling admits it, truly exact.
  const raised = pickDensity('off', 1, 248_000_000, 248_000_000, 512_000_000);
  assertEq(raised.stride, 1);
  assertEq(raised.qSample, 1);
  // The engine allocation limit is a hard wall: no ceiling passes ~1 Gb.
  let hard = '';
  try { pickDensity('off', 1, 2_000_000_000, 2_000_000_000, 8_000_000_000); } catch (e) { hard = String(e); }
  assert(hard.includes('1000 Mb'), `hard limit should hold, got: ${hard}`);
});

test('kmer: maxOcc off (Infinity) disables occurrence masking end to end', () => {
  // The repeat-explosion fixture that a cap of 20 suppresses: uncapped, all
  // 60x60 tandem anchors enumerate.
  const unit = randCodes(20, 71);
  const t = new Uint8Array(20 * 60);
  for (let i = 0; i < 60; i++) t.set(unit, i * 20);
  const open = match(t, starts([1200]), unit.slice(), starts([20]), { maxOcc: Infinity });
  assert(open.length > 50, `uncapped should enumerate the family, got ${open.length}`);
});

test('kmer: pickMaxOcc honors the full user cap when the tail bin fits the budget', () => {
  /** @param {number} tail occSumSq mass in the >=1024 bin */
  const mk = (tail) => {
    const occSumSq = new Float64Array(1025);
    for (let o = 1; o <= 1024; o++) occSumSq[o] = 1e3;
    occSumSq[1024] = tail;
    return /** @type {import('../js/core/kmer.js').KmerIndex} */ (
      /** @type {any} */ ({ occSumSq, stride: 1 })
    );
  };
  // Whole histogram (tail included) fits: 'off' stays off, big finite caps
  // are honored above the 1024-class ceiling.
  assertEq(pickMaxOcc(mk(1e3), 1e6, 1e6, 1, Infinity, 30e6), Infinity);
  assertEq(pickMaxOcc(mk(1e3), 1e6, 1e6, 1, 5000, 30e6), 5000);
  // A tail the budget cannot pay still tightens to a finite cutoff.
  const tightened = pickMaxOcc(mk(1e15), 1e6, 1e6, 1, Infinity, 30e6);
  assert(Number.isFinite(tightened) && tightened <= 1023, `expected finite, got ${tightened}`);
});

test('kmer: pickMaxOcc with the budget off never tightens', () => {
  const occSumSq = new Float64Array(1025);
  for (let o = 1; o <= 1024; o++) occSumSq[o] = 1e12; // huge everywhere
  const idx = /** @type {import('../js/core/kmer.js').KmerIndex} */ (
    /** @type {any} */ ({ occSumSq, stride: 1 })
  );
  // Budget off honors the cap in full, whatever the volume.
  assertEq(pickMaxOcc(idx, 1e6, 1e6, 1, Infinity, Infinity), Infinity);
  assertEq(pickMaxOcc(idx, 1e6, 1e6, 1, 500, Infinity), 500);
  // The same histogram under a finite budget still tightens.
  assert(Number.isFinite(pickMaxOcc(idx, 1e6, 1e6, 1, Infinity, 60e6)));
});

test('kmer: estimateAnchors sums the volume the cap admits', () => {
  const occSumSq = new Float64Array(1025);
  occSumSq[1] = 100;
  occSumSq[10] = 1000;
  occSumSq[1024] = 1e6; // the >=1024 tail bin
  const idx = /** @type {import('../js/core/kmer.js').KmerIndex} */ (
    /** @type {any} */ ({ occSumSq, stride: 1 })
  );
  assertEq(estimateAnchors(idx, 5, 1), 100); // cap 5 admits only class 1
  assertEq(estimateAnchors(idx, 100, 1), 1100); // classes 1 + 10
  assertEq(estimateAnchors(idx, Infinity, 1), 1001100); // tail included
  assertEq(estimateAnchors(idx, Infinity, 2), 2002200); // scale multiplies
});

test('kmer: containmentGrid — cap-free tile identity from exact counts', () => {
  // Four 1 kb tiles: [0]=A, [1]=perfect copy of A, [2]=A at ~5% divergence,
  // [3]=unrelated random. No occurrence cap anywhere in this path.
  const A = randCodes(1024, 91);
  const t = new Uint8Array(4096);
  t.set(A, 0);
  t.set(A, 1024);
  const Am = A.slice();
  const rng = mulberry32(92);
  for (let i = 0; i < 1024; i++) {
    if (rng() < 0.05) Am[i] = (Am[i] + 1 + ((rng() * 3) | 0)) & 3;
  }
  t.set(Am, 2048);
  t.set(randCodes(1024, 93), 3072);
  const index = buildIndex(t, starts([4096]), 12, 1);
  const g = containmentGrid(index, 0, 4096, 0, 4096, 4, 4, 12);
  /** @param {number} x @param {number} y */
  const at = (x, y) => g.grid[y * 4 + x];
  assert(at(0, 0) > 0.999, `self ${at(0, 0)}`);
  assert(at(1, 0) > 0.999, `copy ${at(1, 0)}`);
  assert(at(2, 0) > 0.9 && at(2, 0) < 0.99, `5% diverged ~0.95, got ${at(2, 0)}`);
  assert(at(3, 0) < 0.8, `unrelated background ${at(3, 0)}`);
  // Symmetric ranges give a symmetric grid.
  assert(Math.abs(at(2, 0) - at(0, 2)) < 1e-6);
  // Off-diagonal windows: x and y tile ranges are independent.
  const off = containmentGrid(index, 0, 1024, 1024, 2048, 1, 1, 12);
  assert(off.grid[0] > 0.999, `windowed copy ${off.grid[0]}`);
});

test('kmer: the segment wall is an option, clamped to the hard limit', () => {
  // The repeat fixture from the maxOcc test: uncapped it emits ~3.5k runs.
  const unit = randCodes(20, 7);
  const t = new Uint8Array(20 * 60);
  for (let i = 0; i < 60; i++) t.set(unit, i * 20);
  let msg = '';
  try {
    match(t, starts([1200]), unit.slice(), starts([20]), { maxOcc: 100, maxSegments: 10 });
  } catch (e) {
    msg = String(e);
  }
  assert(msg.includes('Too many match segments'), `tiny wall should trip: ${msg}`);
  // A wall above the emission count passes untouched.
  const ok = match(t, starts([1200]), unit.slice(), starts([20]), { maxOcc: 100, maxSegments: 1_000_000 });
  assert(ok.length > 50, `raised wall passes: ${ok.length}`);
});
