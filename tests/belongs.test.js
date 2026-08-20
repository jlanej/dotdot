// @ts-check
import { test, assert, assertEq, assertClose, mulberry32 } from './harness.js';
import { rcKmer, kmerHash32, pickScaled, belongsMatrix, gatherDecompose } from '../js/core/belongs.js';
import { reverseComplement, stringToCodes } from '../js/core/dna.js';

/** @param {number} n @param {number} seed */
function randCodes(n, seed) {
  const rng = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 4) | 0;
  return out;
}

/** Concatenate records into codes + bounds. @param {Uint8Array[]} recs */
function cat(recs) {
  let total = 0;
  for (const r of recs) total += r.length;
  const codes = new Uint8Array(total);
  const bounds = new Float64Array(recs.length + 1);
  let acc = 0;
  for (let i = 0; i < recs.length; i++) {
    codes.set(recs[i], acc);
    bounds[i] = acc;
    acc += recs[i].length;
  }
  bounds[recs.length] = acc;
  return { codes, bounds };
}

/** Pack codes[0..k) into a k-mer number (both widths). @param {Uint8Array} c @param {number} k */
function pack(c, k) {
  let v = 0;
  for (let i = 0; i < k; i++) v = v * 4 + c[i];
  return v;
}

test('rcKmer narrow: reference parity, involution, palindrome', () => {
  const rng = mulberry32(11);
  for (const k of [4, 8, 13, 16]) {
    for (let t = 0; t < 50; t++) {
      const c = new Uint8Array(k);
      for (let i = 0; i < k; i++) c[i] = (rng() * 4) | 0;
      const kv = pack(c, k);
      const want = pack(reverseComplement(c), k);
      assertEq(rcKmer(kv, k, false), want, `rc parity k=${k}`);
      assertEq(rcKmer(rcKmer(kv, k, false), k, false), kv, `involution k=${k}`);
    }
  }
  const acgt = pack(stringToCodes('ACGT'), 4);
  assertEq(rcKmer(acgt, 4, false), acgt, 'ACGT is its own revcomp');
});

test('rcKmer wide: reference parity and involution at k=20', () => {
  const rng = mulberry32(12);
  for (let t = 0; t < 50; t++) {
    const c = new Uint8Array(20);
    for (let i = 0; i < 20; i++) c[i] = (rng() * 4) | 0;
    const kv = pack(c, 20);
    assertEq(rcKmer(kv, 20, true), pack(reverseComplement(c), 20), 'wide rc parity');
    assertEq(rcKmer(rcKmer(kv, 20, true), 20, true), kv, 'wide involution');
  }
});

test('kmerHash32 spreads and pickScaled ladders', () => {
  // Rough uniformity: over many inputs, about half the hashes land below
  // 2^31 — enough to catch a broken mix (all-zero, sign bugs).
  let below = 0;
  const N = 4096;
  for (let i = 0; i < N; i++) {
    if (kmerHash32(i * 2654435761 + 7) < 2147483648) below++;
  }
  assert(below > N * 0.4 && below < N * 0.6, `hash skewed: ${below}/${N}`);
  assertEq(pickScaled(1000, 24_000_000), 1);
  assertEq(pickScaled(48_000_000, 24_000_000), 2);
  assertEq(pickScaled(200_000_000, 24_000_000), 16);
});

test('matrix: a duplicated record is contained both ways, exactly', () => {
  const a = randCodes(3000, 21);
  const { codes, bounds } = cat([a, a.slice()]);
  const { shared, tot, nR, scaled } = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  assertEq(nR, 2);
  assertEq(scaled, 1);
  assertEq(tot[0], 3000 - 14, 'tot = windows');
  assertEq(tot[1], 3000 - 14);
  assertEq(shared[0 * 2 + 1], tot[0], 'identical records share their whole mass');
});

test('matrix: a reverse-complemented record still belongs (canonical)', () => {
  const a = randCodes(3000, 22);
  const { codes, bounds } = cat([a, reverseComplement(a)]);
  const { shared, tot } = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  assertEq(shared[1], tot[0], 'revcomp record shares everything');
  assertEq(tot[0], tot[1]);
});

test('matrix: wide k canonical containment (k=20, revcomp copy)', () => {
  const a = randCodes(2000, 23);
  const { codes, bounds } = cat([a, reverseComplement(a)]);
  const { shared, tot } = belongsMatrix(codes, bounds, 20, { scaled: 1 });
  assertEq(tot[0], 2000 - 19);
  assertEq(shared[1], tot[0], 'wide canonical containment');
});

test('matrix: prefix record is fully contained, one way', () => {
  const a = randCodes(4000, 24);
  const b = a.slice(0, 2000);
  const { codes, bounds } = cat([a, b]);
  const { shared, tot } = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  assertEq(tot[1], 2000 - 14);
  assertEq(shared[1], tot[1], 'C(prefix | whole) = 1 exactly');
  assertClose(shared[1] / tot[0], 0.498, 0.01, 'C(whole | prefix) ≈ half');
});

test('matrix: unrelated random records share almost nothing', () => {
  const { codes, bounds } = cat([randCodes(4000, 31), randCodes(4000, 32)]);
  const { shared, tot } = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  assert(shared[1] / tot[0] < 0.005, `unrelated containment ${shared[1] / tot[0]}`);
});

test('matrix: multiset counts, not species — deep repeat copy numbers', () => {
  // (ACG)* has only 3 forward species; count-weighted sharing must reflect
  // COPIES (the ModDotPlot set-containment weakness this module avoids).
  const unit = stringToCodes('ACG');
  /** @param {number} reps */
  const rep = (reps) => {
    const out = new Uint8Array(unit.length * reps);
    for (let i = 0; i < reps; i++) out.set(unit, i * unit.length);
    return out;
  };
  const a = rep(40); // 120 bp
  const b = rep(10); // 30 bp
  const { codes, bounds } = cat([a, b]);
  const { shared, tot } = belongsMatrix(codes, bounds, 6, { scaled: 1 });
  assertEq(tot[1], 30 - 5, 'B mass = windows');
  assertEq(shared[1], tot[1], 'shared = B’s full copy mass, not 3 species');
  assert(shared[1] > 20, 'count-weighted, far above species count');
});

test('matrix: totals honor record boundaries, Ns, and short records', () => {
  const a = randCodes(100, 41);
  const b = randCodes(100, 42);
  b[50] = 4; // one N kills exactly k windows mid-record
  const c = randCodes(10, 43); // shorter than k: zero windows
  const { codes, bounds } = cat([a, b, c]);
  const { tot, nR } = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  assertEq(nR, 3);
  assertEq(tot[0], 100 - 14);
  assertEq(tot[1], 100 - 14 - 15, 'one interior N kills k windows');
  assertEq(tot[2], 0, 'sub-k record has no mass');
});

test('matrix: FracMinHash sampling estimates the exact ratios', () => {
  const a = randCodes(20000, 51);
  const b = new Uint8Array(20000);
  b.set(a.slice(0, 10000), 0);
  b.set(randCodes(10000, 52), 10000);
  const { codes, bounds } = cat([a, b]);
  const exact = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  const est = belongsMatrix(codes, bounds, 15, { scaled: 4 });
  assertEq(est.scaled, 4);
  const cExact = exact.shared[1] / exact.tot[1];
  const cEst = est.shared[1] / est.tot[1];
  assertClose(cEst, cExact, 0.03, 'sampled containment tracks exact');
  assert(
    est.tot[0] > exact.tot[0] / 8 && est.tot[0] < exact.tot[0] / 2,
    `sampled mass ~1/4 of exact (got ${est.tot[0]} vs ${exact.tot[0]})`,
  );
});

test('gather: a two-source chimera decomposes into both windows', () => {
  const x = randCodes(6000, 61);
  const y = randCodes(6000, 62);
  const q = new Uint8Array(5000);
  q.set(x.slice(1000, 3500), 0);
  q.set(y.slice(2000, 4500), 2500);
  const { codes, bounds } = cat([x, y, q]);
  const r = gatherDecompose(codes, bounds, 2, 15, {
    scaled: 1,
    maxTiles: 16,
    minFrac: 0.001,
  });
  assertEq(r.totMass, 5000 - 14);
  assertEq(r.components.length, 2, `want 2 components, got ${r.components.length}`);
  const recs = r.components.map((c) => c.rec).sort();
  assertEq(recs[0], 0);
  assertEq(recs[1], 1);
  for (const c of r.components) {
    assertClose(c.mass, 2486, 6, 'each source explains its half');
    if (c.rec === 0) assert(c.lo <= 1000 && c.hi >= 3500, 'X window covers the source span');
    if (c.rec === 1) assert(c.lo <= 8000 && c.hi >= 10500, 'Y window covers the source span');
  }
  // Only the junction-spanning chimeric windows go unexplained.
  assertClose(r.explained, r.totMass - 14, 6, 'all non-chimeric mass claimed');
});

test('gather: duplicate sources — every copy is claimed exactly once', () => {
  const z = randCodes(4000, 71);
  const q = z.slice(0, 2000);
  const { codes, bounds } = cat([z, z.slice(), q]);
  const r = gatherDecompose(codes, bounds, 2, 15, {
    scaled: 1,
    maxTiles: 16,
    minTileBp: 512,
    minFrac: 0.001,
  });
  assertEq(r.totMass, 2000 - 14);
  let sum = 0;
  for (const c of r.components) sum += c.mass;
  assertEq(sum, r.totMass, 'claims are disjoint and complete');
  assertEq(r.components.length, 1, 'one merged component, never double-attributed');
  assertEq(r.components[0].rec, 0, 'deterministic tie-break to the first record');
});

test('gather: novel content stays unexplained', () => {
  const x = randCodes(6000, 81);
  const q = new Uint8Array(3000);
  q.set(x.slice(0, 1500), 0);
  q.set(randCodes(1500, 82), 1500);
  const { codes, bounds } = cat([x, q]);
  const r = gatherDecompose(codes, bounds, 1, 15, { scaled: 1, maxTiles: 16, minFrac: 0.001 });
  const frac = r.explained / r.totMass;
  assert(frac > 0.47 && frac < 0.53, `half explained, got ${frac.toFixed(3)}`);
});

test('gather: paint localizes sources along the record — the chimera signature', () => {
  const x = randCodes(6000, 91);
  const y = randCodes(6000, 92);
  const q = new Uint8Array(5000);
  q.set(x.slice(1000, 3500), 0);
  q.set(y.slice(2000, 4500), 2500);
  const { codes, bounds } = cat([x, y, q]);
  const r = gatherDecompose(codes, bounds, 2, 15, {
    scaled: 1, maxTiles: 16, minFrac: 0.001, qWindows: 10,
  });
  assertEq(r.qWin, 10);
  assertEq(r.qwinBp, 500);
  // Slices 0..4 (record positions 0–2500) came from X (rec 0), 5..9 from Y —
  // a misassembly reads as spatial segmentation, not as blended shares.
  for (let qw = 0; qw < 10; qw++) {
    const fromX = r.paint[qw * 3 + 0];
    const fromY = r.paint[qw * 3 + 1];
    const own = qw < 5 ? fromX : fromY;
    const other = qw < 5 ? fromY : fromX;
    assert(own > 0.9 * r.totalPerQwin[qw], `slice ${qw} dominated by its true source`);
    assert(other < 0.05 * r.totalPerQwin[qw], `slice ${qw} untouched by the other source`);
  }
});

test('gather: contested separates shared homes from unique ones', () => {
  const z = randCodes(4000, 93);
  const q = z.slice(0, 2000);
  // Two identical candidate homes: every claim had a second possible home.
  const dup = cat([z, z.slice(), q]);
  const rd = gatherDecompose(dup.codes, dup.bounds, 2, 15, {
    scaled: 1, maxTiles: 16, minTileBp: 512, minFrac: 0.001,
  });
  assertEq(rd.contestedTotal, rd.explained, 'duplicate homes: all claims contested');
  assert(rd.components[0].contested === rd.components[0].mass, 'per-component contested agrees');
  // One candidate home: nothing is contested.
  const solo = cat([z, q]);
  const rs = gatherDecompose(solo.codes, solo.bounds, 1, 15, {
    scaled: 1, maxTiles: 16, minFrac: 0.001,
  });
  assertEq(rs.contestedTotal, 0, 'a single home cannot be contested');
  assertEq(rs.components[0].contested, 0);
});

test('gather: explicit window override sets the granularity', () => {
  const x = randCodes(6000, 94);
  const q = x.slice(1000, 3000);
  const { codes, bounds } = cat([x, q]);
  const r = gatherDecompose(codes, bounds, 1, 15, { scaled: 1, tileBp: 512, minFrac: 0.001 });
  assertEq(r.tileBp, 512);
  const c = r.components[0];
  assertEq(c.lo % 512, 0, 'windows aligned to the override');
  assert(c.lo <= 1000 && c.hi >= 3000 - 14, 'coverage preserved at fine granularity');
  assertEq(r.explained, r.totMass, 'a pure slice is fully explained');
});

test('matrix: exclusive containment counts only pair-private species', () => {
  // X and Y both carry A (communal); B lives in X and P only; C in Y only.
  const A = randCodes(1500, 101);
  const B = randCodes(1500, 102);
  const C = randCodes(1500, 103);
  const X = new Uint8Array(3000);
  X.set(A, 0);
  X.set(B, 1500);
  const Y = new Uint8Array(3000);
  Y.set(A, 0);
  Y.set(C, 1500);
  const P = B.slice();
  const { codes, bounds } = cat([X, Y, P]);
  const m = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  /** @param {number} i @param {number} j @param {Float64Array} arr */
  const at = (i, j, arr) => (i < j ? arr[i * 3 + j] : arr[j * 3 + i]);
  // P ⊂ X is total, and ALL of it is exclusive (B is nowhere else).
  assertEq(at(2, 0, m.shared), m.tot[2], 'P fully contained in X');
  assertEq(at(2, 0, m.exclusive), m.tot[2], 'and all of it pair-private');
  // X ∩ Y share the communal A — none of it is exclusive-free... it IS
  // pair-exclusive (A lives only in X and Y), so exclusive == shared there.
  assertEq(at(0, 1, m.exclusive), at(0, 1, m.shared), 'A is private to the X,Y pair');
  // P shares nothing meaningful with Y, exclusively or otherwise.
  assert(at(2, 1, m.shared) < 5, 'P and Y unrelated');
});

test('matrix: exclusive drops to zero when a third home holds the content', () => {
  const B = randCodes(2000, 111);
  const X = B.slice();
  const Y = B.slice();
  const P = B.slice(0, 1000);
  const { codes, bounds } = cat([X, Y, P]);
  const m = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  /** @param {number} i @param {number} j @param {Float64Array} arr */
  const at = (i, j, arr) => (i < j ? arr[i * 3 + j] : arr[j * 3 + i]);
  assertEq(at(2, 0, m.shared), m.tot[2], 'P contained in X');
  assertEq(at(2, 0, m.exclusive), 0, 'but nothing is exclusive — Y holds it too');
  assertEq(at(2, 1, m.exclusive), 0);
});

test('matrix: unique-content containment ignores the repeat haze', () => {
  // Two records sharing a deep satellite but with private unique halves:
  // shared containment is inflated by the satellite; unique-content is ~0.
  const unit = stringToCodes('ACGGT');
  const sat = new Uint8Array(1000);
  for (let i = 0; i < 200; i++) sat.set(unit, i * 5);
  const R1 = new Uint8Array(2000);
  R1.set(sat, 0);
  R1.set(randCodes(1000, 121), 1000);
  const R2 = new Uint8Array(2000);
  R2.set(sat, 0);
  R2.set(randCodes(1000, 122), 1000);
  const { codes, bounds } = cat([R1, R2]);
  const m = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  const sharedC = m.shared[1] / m.tot[0];
  const uniqC = m.uniqTot[0] > 0 ? m.uniq[0 * 2 + 1] / m.uniqTot[0] : 0;
  assert(sharedC > 0.3, `satellite inflates shared containment (${sharedC})`);
  assert(uniqC < 0.05, `unique-content sees through it (${uniqC})`);
  // And a genuine fragment keeps unique-content high.
  const F = R1.slice(1200, 1800); // from R1's unique half
  const c2 = cat([R1, R2, F.slice()]);
  const m2 = belongsMatrix(c2.codes, c2.bounds, 15, { scaled: 1 });
  const uniqF = m2.uniq[2 * 3 + 0] / m2.uniqTot[2];
  assert(uniqF > 0.95, `true fragment stays lit in unique mode (${uniqF})`);
});

test('matrix: crossMass ratio reads copy-number skew of shared content', () => {
  const E = randCodes(2000, 131);
  const F = new Uint8Array(6000); // E three times over: 3x the copies
  F.set(E, 0);
  F.set(E, 2000);
  F.set(E, 4000);
  const { codes, bounds } = cat([E, F]);
  const m = belongsMatrix(codes, bounds, 15, { scaled: 1 });
  const ratio = m.crossMass[1 * 2 + 0] / m.crossMass[0 * 2 + 1];
  assertClose(ratio, 3, 0.05, `F carries ~3x the copies of the shared content (${ratio})`);
});
