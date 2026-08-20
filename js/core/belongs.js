// @ts-check
/**
 * Belongs: which sequences share content, and where.
 *
 * Two consumers of one streaming scan over the concatenated records of a
 * plot (target records then query records):
 *
 * - belongsMatrix: exact count-weighted (multiset) k-mer containment between
 *   every pair of records. Σ min(count_i, count_j) per canonical k-mer —
 *   the ANI heatmap's tile statistic, lifted to whole records.
 * - gatherDecompose: a greedy minimum-cover decomposition of ONE record's
 *   k-mer mass over windows of the other records ("62% of this contig is
 *   explained by chr17:18.2–18.6M"). Each k-mer copy is claimed once — the
 *   components are disjoint attributions, not overlapping similarities.
 *
 * Both are strand-CANONICAL: each window contributes min(k-mer, revcomp) —
 * one species per window — so a reverse-complemented contig still belongs.
 *
 * Sampling: the plot index strides POSITIONS, which is fine within one
 * coordinate space but biases cross-record containment (a k-mer must survive
 * sampling independently on every side, so Σ min collapses toward zero for
 * unique content). Here big inputs are sampled by k-mer VALUE instead
 * (FracMinHash): a hash threshold keeps 1/scaled of k-mer space, a species
 * is in or out globally, and count-weighted containment over the sampled
 * species is an unbiased estimate of the exact ratio. scaled = 1 is exact.
 *
 * Shared content is NOT locus homology: repeat-heavy records belong to every
 * record carrying the same family. The display must say so; this counts.
 */

/**
 * Reverse complement of a packed k-mer (2-bit codes, A=0 C=1 G=2 T=3, so the
 * complement of a digit is 3 − d — bitwise NOT within each 2-bit field).
 * Reference implementation for tests and one-off values; the scan itself
 * rolls the rc form incrementally.
 * @param {number} kv packed k-mer (uint32 for k ≤ 16, exact double beyond)
 * @param {number} k
 * @param {boolean} wide k > 16: digit arithmetic instead of bitwise ops
 * @returns {number}
 */
export function rcKmer(kv, k, wide) {
  if (!wide) {
    // Complement every digit, reverse all sixteen 2-bit digits of the uint32,
    // then keep the top 2k bits — the reversal parks the k meaningful digits
    // there and the complemented zero-padding falls off the bottom.
    let x = ~kv >>> 0;
    x = (((x & 0x33333333) << 2) | ((x >>> 2) & 0x33333333)) >>> 0;
    x = (((x & 0x0f0f0f0f) << 4) | ((x >>> 4) & 0x0f0f0f0f)) >>> 0;
    x = (((x & 0x00ff00ff) << 8) | ((x >>> 8) & 0x00ff00ff)) >>> 0;
    x = ((x << 16) | (x >>> 16)) >>> 0;
    return x >>> (32 - 2 * k);
  }
  let v = kv;
  let out = 0;
  for (let i = 0; i < k; i++) {
    const d = v % 4;
    out = out * 4 + (3 - d);
    v = (v - d) / 4;
  }
  return out;
}

/**
 * 32-bit avalanche hash of a packed k-mer (an exact integer ≤ 2^52), for
 * FracMinHash value-sampling. Not cryptographic — just uniform enough that
 * "hash < 2^32/scaled" keeps an unbiased 1/scaled of k-mer space.
 * @param {number} v
 */
export function kmerHash32(v) {
  const lo = v % 67108864; // low 26 bits
  const hi = (v - lo) / 67108864;
  let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2b591e5b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Pick the FracMinHash sampling rate: the smallest power of two keeping the
 * expected sampled entry count under the cap. scaled = 1 means exact.
 * @param {number} totalBp @param {number} [cap] max sampled entries
 */
export function pickScaled(totalBp, cap = 24_000_000) {
  let scaled = 1;
  while (totalBp / scaled > cap) scaled *= 2;
  return scaled;
}

/**
 * The one scan both features share: roll every window's forward and
 * reverse-complement forms in tandem across the concatenation (runs break at
 * N and at bucket edges' record boundaries exactly like buildIndex), take
 * the canonical form, keep it when it passes the FracMinHash threshold, and
 * emit (canonical k-mer, bucket) pairs SORTED by k-mer — so equal-species
 * runs are contiguous for the callers' counting walks.
 *
 * Buckets are the caller's partition of the concatenation: record bounds for
 * the matrix, per-record windows for gather. Edges must be monotone, start
 * at 0 and end at codes.length; k-mer windows never straddle an edge (an
 * edge is always a record boundary or a window cut inside one record — for
 * the matrix the former; gather passes both kinds and cuts ARE allowed to
 * split runs: a window is assigned to the bucket its START lies in, matching
 * how the plot assigns anchors).
 *
 * @param {Uint8Array} codes 2-bit codes of the concatenation
 * @param {Float64Array | number[]} starts record boundaries (run breaks)
 * @param {Float64Array | number[]} edges bucket boundaries
 * @param {number} k 4..26
 * @param {number} scaled FracMinHash rate (1 = keep everything)
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {{kv: Float64Array, bucket: Int32Array, n: number}}
 */
export function scanCanonical(codes, starts, edges, k, scaled, onProgress) {
  if (k < 4 || k > 26) throw new Error(`k must be 4..26 (got ${k})`);
  const n = codes.length;
  const wide = k > 16;
  const kbits = 2 * k;
  const mask = wide ? 0 : kbits === 32 ? 0xffffffff : (1 << kbits) - 1;
  const top = Math.pow(4, k - 1);
  const rcShiftHi = 2 * (k - 1);
  const threshold = scaled > 1 ? Math.floor(4294967296 / scaled) : 0;

  let cap = Math.max(1 << 16, Math.min(n + 1, Math.ceil((n / scaled) * 1.5) + 1024));
  let kv = new Float64Array(cap);
  let bucket = new Int32Array(cap);
  let m = 0;

  let fwd = 0;
  let rc = 0;
  let run = 0;
  let rec = 1;
  let edge = 1;
  for (let i = 0; i < n; i++) {
    while (i >= starts[rec]) {
      rec++;
      run = 0;
    }
    const c = codes[i];
    if (c < 4) {
      if (wide) {
        const hi = Math.floor(fwd / top);
        fwd = (fwd - hi * top) * 4 + c;
        rc = Math.floor(rc / 4) + (3 - c) * top;
      } else {
        fwd = (((fwd << 2) | c) & mask) >>> 0;
        // Right-roll: the insert lands at the fixed top digit and everything
        // below shifts down, so rc never grows past its 2k-bit window.
        rc = ((rc >>> 2) | ((3 - c) << rcShiftHi)) >>> 0;
      }
      run++;
    } else {
      run = 0;
    }
    if (run >= k) {
      const canon = fwd < rc ? fwd : rc;
      if (threshold === 0 || kmerHash32(canon) < threshold) {
        const p = i - k + 1;
        while (p >= edges[edge]) edge++;
        if (m === cap) {
          cap *= 2;
          const a = new Float64Array(cap);
          a.set(kv);
          kv = a;
          const b = new Int32Array(cap);
          b.set(bucket);
          bucket = b;
        }
        kv[m] = canon;
        bucket[m] = edge - 1;
        m++;
      }
    }
    if (onProgress && (i & 0xfffff) === 0) onProgress(i, n);
  }
  dualSort(kv, bucket, 0, m - 1);
  return { kv, bucket, n: m };
}

/**
 * Iterative dual-array quicksort of kv[lo..hi] (inclusive), mirroring swaps
 * into bucket[]. Same shape as the engine's sortPairs — kept local so this
 * module stays standalone (and the bucket array is Int32, not Uint32).
 * @param {Float64Array} kv @param {Int32Array} bucket
 * @param {number} lo @param {number} hi
 */
function dualSort(kv, bucket, lo, hi) {
  /** @type {number[]} */
  const stack = [];
  if (lo < hi) stack.push(lo, hi);
  while (stack.length > 0) {
    const h = /** @type {number} */ (stack.pop());
    const l = /** @type {number} */ (stack.pop());
    if (h - l < 16) {
      for (let i = l + 1; i <= h; i++) {
        const vk = kv[i];
        const vb = bucket[i];
        let j = i - 1;
        while (j >= l && kv[j] > vk) {
          kv[j + 1] = kv[j];
          bucket[j + 1] = bucket[j];
          j--;
        }
        kv[j + 1] = vk;
        bucket[j + 1] = vb;
      }
      continue;
    }
    const mid = l + ((h - l) >>> 1);
    if (kv[mid] < kv[l]) swap2(kv, bucket, mid, l);
    if (kv[h] < kv[l]) swap2(kv, bucket, h, l);
    if (kv[h] < kv[mid]) swap2(kv, bucket, h, mid);
    const pivot = kv[mid];
    let i = l;
    let j = h;
    while (i <= j) {
      while (kv[i] < pivot) i++;
      while (kv[j] > pivot) j--;
      if (i <= j) {
        swap2(kv, bucket, i, j);
        i++;
        j--;
      }
    }
    if (l < j) stack.push(l, j);
    if (i < h) stack.push(i, h);
  }
}

/** @param {Float64Array} kv @param {Int32Array} bucket @param {number} i @param {number} j */
function swap2(kv, bucket, i, j) {
  const tk = kv[i];
  kv[i] = kv[j];
  kv[j] = tk;
  const tb = bucket[i];
  bucket[i] = bucket[j];
  bucket[j] = tb;
}

/**
 * Count-weighted containment between every pair of records.
 *
 * shared[i*nR + j] (i < j; the numerator is symmetric) = Σ over canonical
 * k-mer species of min(count in record i, count in record j); tot[r] =
 * record r's sampled k-mer mass. Containment of i in j = shared / tot[i];
 * the ANI estimate is (shared / min(tot_i, tot_j))^(1/k) — the ANI heatmap's
 * exact statistic. All masses live in the same 1/scaled sample of k-mer
 * space, so the ratios estimate the exact ones without cross-side bias.
 *
 * @param {Uint8Array} codes concatenation of every record's codes
 * @param {Float64Array | number[]} bounds record boundaries, bounds[0] = 0,
 *   bounds[nR] = codes.length
 * @param {number} k
 * @param {{scaled?: number, cap?: number}} [opts]
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {{shared: Float64Array, tot: Float64Array, nR: number, scaled: number}}
 */
export function belongsMatrix(codes, bounds, k, opts = {}, onProgress) {
  const nR = bounds.length - 1;
  const scaled = opts.scaled ?? pickScaled(codes.length, opts.cap);
  const s = scanCanonical(codes, bounds, bounds, k, scaled, onProgress);
  const shared = new Float64Array(nR * nR);
  const tot = new Float64Array(nR);
  const cnt = new Float64Array(nR);
  const touched = new Int32Array(nR);
  const { kv, bucket, n } = s;
  let g = 0;
  while (g < n) {
    const v = kv[g];
    let e = g + 1;
    while (e < n && kv[e] === v) e++;
    let nT = 0;
    for (let j = g; j < e; j++) {
      const r = bucket[j];
      if (cnt[r] === 0) touched[nT++] = r;
      cnt[r]++;
    }
    for (let a = 0; a < nT; a++) {
      const ra = touched[a];
      const ca = cnt[ra];
      tot[ra] += ca;
      for (let b = a + 1; b < nT; b++) {
        const rb = touched[b];
        const m = ca < cnt[rb] ? ca : cnt[rb];
        // One symmetric write per unordered pair, at [min, max].
        if (ra < rb) shared[ra * nR + rb] += m;
        else shared[rb * nR + ra] += m;
      }
    }
    for (let a = 0; a < nT; a++) cnt[touched[a]] = 0;
    g = e;
  }
  return { shared, tot, nR, scaled };
}

/**
 * @typedef {Object} GatherComponent
 * @property {number} rec record index the window lives in
 * @property {number} lo window start, concatenation coords (inclusive)
 * @property {number} hi window end, concatenation coords (exclusive)
 * @property {number} mass sampled k-mer mass claimed by this window
 * @property {number} contested claimed mass whose species also occur in at
 *   least one OTHER record — content that could have landed elsewhere; the
 *   greedy's choice between such homes is parsimony (ties break to load
 *   order), not evidence
 */

/**
 * Greedy decomposition of record `rec`'s k-mer mass over uniform windows of
 * every OTHER record: sourmash-gather semantics at window resolution.
 *
 * Claiming is a transportation step under twin budgets — per species,
 * take = min(record copies remaining, window copies unspent), debited from
 * BOTH sides — so claims are disjoint: a record copy is never explained
 * twice and a window never explains more copies than it holds. Adjacent
 * chosen windows of one record merge into ranges.
 *
 * Beyond the components, two diagnostics separate "misassembled" from
 * "highly homologous" from "clearly one source":
 * - paint: the record is split into qWindows equal slices, and every claim
 *   is distributed over the slices its species occupies (proportional to
 *   the species' copy counts there). paint[qw*nR + r] = claimed mass of
 *   slice qw attributed to record r. A chimera shows spatially SEGMENTED
 *   colors; a clean placement one color; unexplained slices stay dark.
 * - contested (per component + total): claimed mass whose species exist in
 *   ≥ 2 distinct candidate records. High contested = the attribution was a
 *   coin flip between near-equal homes — read the matrix row for ambiguity.
 *
 * @param {Uint8Array} codes concatenation of every record's codes
 * @param {Float64Array | number[]} bounds record boundaries (see belongsMatrix)
 * @param {number} rec the record to decompose
 * @param {number} k
 * @param {{scaled?: number, cap?: number, maxTiles?: number, maxRounds?: number,
 *          minFrac?: number, minTileBp?: number, tileBp?: number, qWindows?: number}} [opts]
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {{components: GatherComponent[], totMass: number, explained: number,
 *            contestedTotal: number, tileBp: number, scaled: number,
 *            truncated: boolean, paint: Float64Array, qWin: number,
 *            qwinBp: number, totalPerQwin: Float64Array}}
 */
export function gatherDecompose(codes, bounds, rec, k, opts = {}, onProgress) {
  const nR = bounds.length - 1;
  const maxTiles = Math.max(16, opts.maxTiles ?? 192);
  const maxRounds = Math.max(1, opts.maxRounds ?? 2048);
  const minFrac = opts.minFrac ?? 0.001;
  const scaled = opts.scaled ?? pickScaled(codes.length, opts.cap);
  const recLo = Number(bounds[rec]);
  const recHi = Number(bounds[rec + 1]);
  const recLen = Math.max(1, recHi - recLo);
  const otherSpan = Math.max(1, codes.length - (recHi - recLo));
  // Window width: explicit override (floored, and coarsened so the tile
  // count stays walkable), else span/budget with a floor.
  let tileBp;
  if (opts.tileBp && opts.tileBp > 0) {
    tileBp = Math.max(256, Math.floor(opts.tileBp), Math.ceil(otherSpan / 8192));
  } else {
    tileBp = Math.max(opts.minTileBp ?? 1024, Math.ceil(otherSpan / maxTiles));
  }
  const qWinAsk = Math.max(1, Math.min(opts.qWindows ?? 96, recLen));
  const qwinBp = Math.ceil(recLen / qWinAsk);
  // The realized slice count (ceil rounding can undershoot the ask).
  const qWin = Math.ceil(recLen / qwinBp);

  // Bucket edges: every record's uniform window cuts; rec itself is cut into
  // qWin slices (bucket ids [recB0, recB0+qWin)) so claims can be localized
  // along the record being explained.
  /** @type {number[]} */
  const edges = [0];
  /** @type {number[]} */
  const bucketRec = [];
  /** @type {number[]} */
  const bucketLo = [];
  let recB0 = -1;
  for (let r = 0; r < nR; r++) {
    const lo = Number(bounds[r]);
    const hi = Number(bounds[r + 1]);
    const step = r === rec ? qwinBp : tileBp;
    if (r === rec) recB0 = edges.length - 1;
    for (let t = lo; t < hi; t += step) {
      bucketRec.push(r);
      bucketLo.push(t);
      edges.push(Math.min(hi, t + step));
    }
  }
  const recB1 = recB0 + qWin;
  const nB = edges.length - 1;

  const s = scanCanonical(codes, bounds, edges, k, scaled, onProgress);
  const { kv, bucket, n } = s;

  // Materialize per-species data for species present in rec: target-side
  // (tile, count) runs, record-side (slice, count) runs, the record count,
  // and how many DISTINCT candidate records hold the species (contested).
  let gCap = 1 << 14;
  let gRecCnt = new Float64Array(gCap);
  let gRunStart = new Int32Array(gCap + 1);
  let gQStart = new Int32Array(gCap + 1);
  let gMultiRec = new Uint8Array(gCap);
  let nG = 0;
  let tCap = 1 << 16;
  let tTile = new Int32Array(tCap);
  let tCnt = new Float64Array(tCap);
  let nT = 0;
  let qCap = 1 << 16;
  let qSlice = new Int32Array(qCap);
  let qCnt = new Float64Array(qCap);
  let nQ = 0;
  const cnt = new Float64Array(nB);
  const touched = new Int32Array(nB);
  const totalPerQwin = new Float64Array(qWin);
  let totMass = 0;

  let g = 0;
  while (g < n) {
    const v = kv[g];
    let e = g + 1;
    while (e < n && kv[e] === v) e++;
    let cRec = 0;
    let nTouched = 0;
    let nQTouched = 0;
    for (let j = g; j < e; j++) {
      const b = bucket[j];
      if (b >= recB0 && b < recB1) {
        cRec++;
      } else {
        if (cnt[b] === 0) touched[nTouched++] = b;
        cnt[b]++;
      }
    }
    if (cRec > 0) {
      totMass += cRec;
      // Record-side slice counts (second pass over the run, rec buckets only).
      for (let j = g; j < e; j++) {
        const b = bucket[j];
        if (b >= recB0 && b < recB1) {
          if (cnt[b] === 0) {
            touched[nTouched + nQTouched] = b;
            nQTouched++;
          }
          cnt[b]++;
        }
      }
      for (let a = 0; a < nQTouched; a++) {
        const b = touched[nTouched + a];
        totalPerQwin[b - recB0] += cnt[b];
      }
      if (nTouched > 0) {
        if (nG === gCap) {
          gCap *= 2;
          const a = new Float64Array(gCap);
          a.set(gRecCnt);
          gRecCnt = a;
          const b2 = new Int32Array(gCap + 1);
          b2.set(gRunStart);
          gRunStart = b2;
          const b3 = new Int32Array(gCap + 1);
          b3.set(gQStart);
          gQStart = b3;
          const b4 = new Uint8Array(gCap);
          b4.set(gMultiRec);
          gMultiRec = b4;
        }
        while (nT + nTouched > tCap) {
          tCap *= 2;
          const a = new Int32Array(tCap);
          a.set(tTile.subarray(0, nT));
          tTile = a;
          const b2 = new Float64Array(tCap);
          b2.set(tCnt.subarray(0, nT));
          tCnt = b2;
        }
        while (nQ + nQTouched > qCap) {
          qCap *= 2;
          const a = new Int32Array(qCap);
          a.set(qSlice.subarray(0, nQ));
          qSlice = a;
          const b2 = new Float64Array(qCap);
          b2.set(qCnt.subarray(0, nQ));
          qCnt = b2;
        }
        gRecCnt[nG] = cRec;
        gRunStart[nG] = nT;
        gQStart[nG] = nQ;
        let firstRec = -1;
        let multi = 0;
        for (let a = 0; a < nTouched; a++) {
          const t = touched[a];
          tTile[nT] = t;
          tCnt[nT] = cnt[t];
          nT++;
          const tr = bucketRec[t];
          if (firstRec < 0) firstRec = tr;
          else if (tr !== firstRec) multi = 1;
        }
        gMultiRec[nG] = multi;
        for (let a = 0; a < nQTouched; a++) {
          const b = touched[nTouched + a];
          qSlice[nQ] = b - recB0;
          qCnt[nQ] = cnt[b];
          nQ++;
        }
        nG++;
      }
    }
    for (let a = 0; a < nTouched + nQTouched; a++) cnt[touched[a]] = 0;
    g = e;
  }
  gRunStart[nG] = nT;
  gQStart[nG] = nQ;

  // Greedy transportation rounds (see the claim contract in the JSDoc).
  const tpStart = new Int32Array(nB + 1);
  for (let j = 0; j < nT; j++) tpStart[tTile[j] + 1]++;
  for (let t = 0; t < nB; t++) tpStart[t + 1] += tpStart[t];
  const tpSpecies = new Int32Array(nT);
  const tpPair = new Int32Array(nT);
  {
    const cur = tpStart.slice(0, nB);
    for (let gi = 0; gi < nG; gi++) {
      for (let j = gRunStart[gi]; j < gRunStart[gi + 1]; j++) {
        const at = cur[tTile[j]]++;
        tpSpecies[at] = gi;
        tpPair[at] = j;
      }
    }
  }

  const remaining = gRecCnt.slice(0, nG);
  const used = new Float64Array(nT);
  const perTile = new Float64Array(nB);
  for (let gi = 0; gi < nG; gi++) {
    const rem = remaining[gi];
    for (let j = gRunStart[gi]; j < gRunStart[gi + 1]; j++) {
      const c = tCnt[j];
      perTile[tTile[j]] += c < rem ? c : rem;
    }
  }
  const claimed = new Float64Array(nB);
  const contestedTile = new Float64Array(nB);
  const paint = new Float64Array(qWin * nR);
  const minFloor = Math.max(1, minFrac * totMass);
  let truncated = false;
  for (let round = 0; round < maxRounds; round++) {
    let best = -1;
    let bestMass = 0;
    for (let t = 0; t < nB; t++) {
      if ((t < recB0 || t >= recB1) && perTile[t] > bestMass) {
        bestMass = perTile[t];
        best = t;
      }
    }
    if (best < 0 || bestMass < minFloor) break;
    if (round === maxRounds - 1) truncated = true;
    const bestRec = bucketRec[best];
    for (let a = tpStart[best]; a < tpStart[best + 1]; a++) {
      const gi = tpSpecies[a];
      const j0 = tpPair[a];
      const rem = remaining[gi];
      if (rem <= 0) continue;
      const cap0 = tCnt[j0] - used[j0];
      if (cap0 <= 0) continue;
      const take = rem < cap0 ? rem : cap0;
      const newRem = rem - take;
      for (let j = gRunStart[gi]; j < gRunStart[gi + 1]; j++) {
        const capJ = tCnt[j] - used[j];
        const oldC = rem < capJ ? rem : capJ;
        const capN = j === j0 ? capJ - take : capJ;
        const newC = newRem < capN ? newRem : capN;
        perTile[tTile[j]] += newC - oldC;
      }
      used[j0] += take;
      remaining[gi] = newRem;
      claimed[best] += take;
      if (gMultiRec[gi]) contestedTile[best] += take;
      // Localize the claim along the record: spread it over the slices this
      // species occupies, weighted by the species' copies there.
      const scale = take / gRecCnt[gi];
      for (let j = gQStart[gi]; j < gQStart[gi + 1]; j++) {
        paint[qSlice[j] * nR + bestRec] += qCnt[j] * scale;
      }
    }
  }

  // Components = maximal runs of adjacent claimed windows within one record.
  /** @type {GatherComponent[]} */
  const components = [];
  let explained = 0;
  let contestedTotal = 0;
  for (let t = 0; t < nB; t++) {
    if (claimed[t] <= 0) continue;
    explained += claimed[t];
    contestedTotal += contestedTile[t];
    const r = bucketRec[t];
    const lo = bucketLo[t];
    const hi = Number(edges[t + 1]);
    const last = components[components.length - 1];
    if (last && last.rec === r && last.hi === lo) {
      last.hi = hi;
      last.mass += claimed[t];
      last.contested += contestedTile[t];
    } else {
      components.push({ rec: r, lo, hi, mass: claimed[t], contested: contestedTile[t] });
    }
  }
  components.sort((a, b) => b.mass - a.mass);
  return {
    components, totMass, explained, contestedTotal, tileBp, scaled, truncated,
    paint, qWin, qwinBp, totalPerQwin,
  };
}
