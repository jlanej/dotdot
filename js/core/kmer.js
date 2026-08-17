// @ts-check
/**
 * Exact k-mer matching engine for dot plots.
 *
 * Design (all flat typed arrays, no objects in hot loops):
 *  1. buildIndex(): every valid k-mer of the target is packed into 2 bits/base
 *     (k <= 16 fits a uint32), laid out in buckets keyed by the k-mer's high
 *     bits via counting sort, then each bucket is sorted by full k-mer so
 *     lookups are a binary search + a contiguous occurrence group.
 *  2. matchStrand(): rolls over the query (or its reverse complement),
 *     looks up each k-mer, and feeds anchors into a diagonal run-merger —
 *     consecutive anchors on the same diagonal collapse into one segment,
 *     optionally bridging up to `maxGap` mismatched bases (identity is
 *     accounted per bridged gap). This is what keeps segment counts in the
 *     millions instead of the billions on real genomes.
 *
 * Repetitive k-mers occurring more than `maxOcc` times in the target are
 * skipped entirely (minimap2-style repeat masking); `stride` subsamples the
 * target index for very large inputs.
 */

/**
 * @typedef {Object} KmerOptions
 * @property {number} k          word size, 4..16
 * @property {number} maxGap     bridge runs on one diagonal across <= this many bases
 * @property {number} maxOcc     skip k-mers with more target occurrences than this
 * @property {number} minRunLen  drop merged runs shorter than this many bases (0 = keep all)
 * @property {number} stride     index every stride-th target k-mer (1 = all)
 * @property {number} [qSample]  test every qSample-th query position (1 = all).
 *   Sampling both sides thins anchors on a diagonal to ~every stride*qSample bp;
 *   run merging bridges those sampling holes without an identity penalty.
 */

/**
 * @typedef {Object} KmerIndex
 * @property {Uint32Array | Float64Array} kmers  packed k-mers, bucket-grouped, sorted within bucket
 * @property {Uint32Array} pos     target positions parallel to `kmers`
 * @property {Uint32Array} bucketStarts  length nBuckets+1
 * @property {number} k
 * @property {boolean} wide        k > 16: k-mers are exact integers in Float64Array
 * @property {number} shift        narrow path: kmer >>> shift = bucket id
 * @property {number} mask         narrow path: rolling mask
 * @property {number} top          wide path: 4^(k-1), the leading-base place value
 * @property {number} prefDiv      wide path: bucket id = floor(kmer / prefDiv)
 * @property {number} stride       target subsampling the index was built with (1 = every k-mer)
 * @property {Float64Array} occSumSq  sum of occ^2 per occurrence class (index 1..1024)
 * @property {Float64Array} occCount  distinct k-mer groups per occurrence class
 *   (1..1023 exact; index 1024 = everything ≥1024) — the occurrence spectrum
 */

/**
 * @typedef {Object} SegmentVecs
 * @property {import('./vec.js').F64Vec} x
 * @property {import('./vec.js').F64Vec} y
 * @property {import('./vec.js').F32Vec} dx
 * @property {import('./vec.js').F32Vec} dy
 * @property {import('./vec.js').U8Vec} strand
 * @property {import('./vec.js').F32Vec} identity
 * @property {import('./vec.js').U8Vec} [edge] 1 = run touched a [qLo,qHi)
 *   cut and may continue in a neighboring chunk (pool workers only; such
 *   pieces bypass minRunLen here and are stitched + re-filtered on assembly)
 */

export const KMER_DEFAULTS = Object.freeze({
  k: 15,
  maxGap: 0,
  maxOcc: 200,
  minRunLen: 0,
  stride: 1,
  qSample: 1,
});

export const MAX_SEGMENTS = 16_000_000;

/** Default largest target an exact (sampling off) compute may index: every
 * k-mer of the worked extent lives in RAM, ~8–12 bytes per base. The user
 * may raise it ("off 512M") up to the engine's allocation limit. */
export const EXACT_MAX_BP = 128_000_000;

/** Absolute exact-mode ceiling: past ~1 Gb the position array alone nears
 * the 4 GB TypedArray limit — allocation, not policy. */
export const EXACT_HARD_BP = 1_000_000_000;

/**
 * Resolve the sampling mode into concrete densities. 'off' is TRUE full
 * density — every target k-mer indexed (stride 1) and every query position
 * tested — refused with guidance when the target extent exceeds the
 * ceiling, never silently degraded (a strided index enforces occurrence
 * caps in sampled units, which is exactly what "off" must not do). The
 * ceiling defaults to EXACT_MAX_BP and is user-raisable per compute
 * ("off 512M") for deep drills and publication figures — RAM and minutes
 * are the user's to spend, silent approximation is not. 'auto' and numbers
 * thin the query side; the target strides independently past 48 Mb to keep
 * the index in budget.
 *
 * @param {'auto'|'off'|number|undefined} sample
 * @param {number} strideFloor user stride option (>= 1)
 * @param {number} tLenEff target bases in the worked extent
 * @param {number} qLenEff query bases in the worked extent
 * @param {number} [maxBp] user-raised exact ceiling (clamped to sane bounds)
 * @returns {{stride: number, qSample: number}}
 */
export function pickDensity(sample, strideFloor, tLenEff, qLenEff, maxBp) {
  if (sample === 'off') {
    const ceiling = Math.min(EXACT_HARD_BP, Math.max(1_000_000, maxBp ?? EXACT_MAX_BP));
    if (tLenEff > ceiling) {
      const gbLo = ((tLenEff * 8) / 1e9).toFixed(1);
      const gbHi = ((tLenEff * 12) / 1e9).toFixed(1);
      throw new Error(
        `Exact mode indexes every target k-mer — ${Math.round(tLenEff / 1e6)} Mb needs ` +
          `~${gbLo}–${gbHi} GB of index RAM, over the current ${Math.round(ceiling / 1e6)} Mb ` +
          `ceiling. Raise it if this machine can pay (type "off ${Math.ceil(tLenEff / 1e6)}M" ` +
          `in sampling, engine limit ${EXACT_HARD_BP / 1e6} Mb), zoom in and Refine, or use ` +
          'auto/numbered sampling.',
      );
    }
    return { stride: 1, qSample: 1 };
  }
  const autoStride = Math.max(1, Math.ceil(tLenEff / 48_000_000));
  const stride = Math.max(strideFloor, autoStride);
  const autoQ = Math.max(1, Math.ceil(qLenEff / 48_000_000));
  const qSample =
    sample == null || sample === 'auto' ? autoQ : Math.max(1, Math.floor(sample));
  return { stride, qSample };
}

const PROGRESS_EVERY = 1 << 21;

/**
 * Restricting [tLo, tHi) indexes only k-mers *starting* in that target range
 * (with rolling warm-up), for region-refine passes — positions stay global.
 *
 * @param {Uint8Array} codes
 * @param {Float64Array} starts record boundaries (R+1 entries, last = length)
 * @param {number} k
 * @param {number} stride
 * @param {(done: number, total: number) => void} [onProgress]
 * @param {number} [tLo] first k-mer start position to index (inclusive)
 * @param {number} [tHi] end of k-mer start positions (exclusive)
 * @param {(kind: 'kmers'|'pos'|'buckets', len: number) => Uint32Array|Float64Array} [alloc]
 *   custom array allocator — the pool path passes SharedArrayBuffer-backed
 *   arrays so the index is born shared instead of built then copied
 * @returns {KmerIndex}
 */
export function buildIndex(codes, starts, k, stride, onProgress, tLo = 0, tHi = codes.length, alloc) {
  if (k < 4 || k > 26) throw new Error(`k must be 4..26 (got ${k})`);
  if (stride < 1) throw new Error('stride must be >= 1');
  const n = codes.length;
  if (n >= 2 ** 32 - 2) throw new Error('Sequence too large for in-browser matching — import a minimap2 PAF instead.');

  // k <= 16 packs into a uint32 and rolls with bitwise ops; k <= 26 packs
  // into the exact-integer range of a double (2k <= 52 bits) and rolls with
  // top-digit-removal arithmetic — every value stays a bit-exact integer.
  const wide = k > 16;
  const kbits = 2 * k;
  const mask = wide ? 0 : kbits === 32 ? 0xffffffff : (1 << kbits) - 1;
  const top = wide ? Math.pow(4, k - 1) : 0;
  const prefixBits = Math.min(22, Math.max(8, Math.ceil(Math.log2(Math.max(n, 256)))), kbits);
  const shift = kbits - prefixBits;
  const prefDiv = wide ? Math.pow(2, shift) : 0;
  const nBuckets = 1 << prefixBits;

  const startI = Math.max(0, tLo - (k - 1));
  const endI = Math.min(n, tHi + k - 1);
  const span = Math.max(1, endI - startI);
  let recInit = 1;
  while (recInit < starts.length - 1 && starts[recInit] <= startI) recInit++;

  // Pass 1: bucket occupancy.
  const bucketStarts = /** @type {Uint32Array} */ (
    alloc ? alloc('buckets', nBuckets + 1) : new Uint32Array(nBuckets + 1)
  );
  {
    let kmer = 0;
    let run = 0;
    let rec = recInit;
    for (let i = startI; i < endI; i++) {
      while (i >= starts[rec]) {
        rec++;
        run = 0;
      }
      const c = codes[i];
      if (c < 4) {
        if (wide) {
          const hi = Math.floor(kmer / top);
          kmer = (kmer - hi * top) * 4 + c;
        } else {
          kmer = (((kmer << 2) | c) & mask) >>> 0;
        }
        run++;
      } else {
        run = 0;
      }
      if (run >= k) {
        const p = i - k + 1;
        if (p >= tLo && (stride === 1 || p % stride === 0)) {
          const b = wide ? Math.floor(kmer / prefDiv) : kmer >>> shift;
          bucketStarts[b + 1]++;
        }
      }
      if (onProgress && (i & (PROGRESS_EVERY - 1)) === 0) onProgress(i - startI, 2 * span);
    }
  }

  for (let b = 0; b < nBuckets; b++) bucketStarts[b + 1] += bucketStarts[b];
  const total = bucketStarts[nBuckets];
  const kmers = alloc ? alloc('kmers', total) : wide ? new Float64Array(total) : new Uint32Array(total);
  const pos = /** @type {Uint32Array} */ (alloc ? alloc('pos', total) : new Uint32Array(total));

  // Pass 2: fill buckets.
  {
    const cur = bucketStarts.slice(0, nBuckets);
    let kmer = 0;
    let run = 0;
    let rec = recInit;
    for (let i = startI; i < endI; i++) {
      while (i >= starts[rec]) {
        rec++;
        run = 0;
      }
      const c = codes[i];
      if (c < 4) {
        if (wide) {
          const hi = Math.floor(kmer / top);
          kmer = (kmer - hi * top) * 4 + c;
        } else {
          kmer = (((kmer << 2) | c) & mask) >>> 0;
        }
        run++;
      } else {
        run = 0;
      }
      if (run >= k) {
        const p = i - k + 1;
        if (p >= tLo && (stride === 1 || p % stride === 0)) {
          const b = wide ? Math.floor(kmer / prefDiv) : kmer >>> shift;
          const j = cur[b]++;
          kmers[j] = kmer;
          pos[j] = p;
        }
      }
      if (onProgress && (i & (PROGRESS_EVERY - 1)) === 0) onProgress(span + (i - startI), 2 * span);
    }
  }

  // Sort each bucket by full k-mer so occurrences of one k-mer are contiguous
  // and findable by binary search. Position order within one k-mer's group is
  // irrelevant to the plot.
  for (let b = 0; b < nBuckets; b++) {
    const lo = bucketStarts[b];
    const hi = bucketStarts[b + 1];
    if (hi - lo > 1) sortPairs(kmers, pos, lo, hi - 1);
  }

  // Occurrence-class weights: occSumSq[o] = sum of occ^2 over k-mer groups
  // with occ occurrences (occ >= 1024 binned together). Anchor volume against
  // a same-composition query scales with occ^2, so this histogram lets the
  // caller choose a repeat cutoff that meets an anchor budget instead of
  // guessing (Alu-family k-mers otherwise flood genome-scale plots).
  const occSumSq = new Float64Array(1025);
  const occCount = new Float64Array(1025);
  for (let b = 0; b < nBuckets; b++) {
    const hiB = bucketStarts[b + 1];
    let g = bucketStarts[b];
    while (g < hiB) {
      const kv = kmers[g];
      let e = g + 1;
      while (e < hiB && kmers[e] === kv) e++;
      const occ = e - g;
      const cls = occ < 1024 ? occ : 1024;
      occSumSq[cls] += occ * occ;
      occCount[cls] += 1;
      g = e;
    }
  }

  return { kmers, pos, bucketStarts, k, wide, shift, mask, top, prefDiv, stride, occSumSq, occCount };
}

/**
 * Iterative dual-array quicksort of kmers[lo..hi] (inclusive), mirroring
 * swaps into pos[]. Median-of-three pivot; insertion sort under 16 elements.
 * Robust on the adversarial case (one huge low-complexity bucket).
 * @param {Uint32Array | Float64Array} kmers
 * @param {Uint32Array} pos
 * @param {number} lo
 * @param {number} hi
 */
function sortPairs(kmers, pos, lo, hi) {
  /** @type {number[]} */
  const stack = [lo, hi];
  while (stack.length > 0) {
    const h = /** @type {number} */ (stack.pop());
    const l = /** @type {number} */ (stack.pop());
    if (h - l < 16) {
      for (let i = l + 1; i <= h; i++) {
        const kv = kmers[i];
        const pv = pos[i];
        let j = i - 1;
        while (j >= l && kmers[j] > kv) {
          kmers[j + 1] = kmers[j];
          pos[j + 1] = pos[j];
          j--;
        }
        kmers[j + 1] = kv;
        pos[j + 1] = pv;
      }
      continue;
    }
    const mid = l + ((h - l) >>> 1); // overflow-safe at 2^31+ entries
    // median-of-three into mid
    if (kmers[l] > kmers[mid]) swap(kmers, pos, l, mid);
    if (kmers[l] > kmers[h]) swap(kmers, pos, l, h);
    if (kmers[mid] > kmers[h]) swap(kmers, pos, mid, h);
    const pivot = kmers[mid];
    let i = l;
    let j = h;
    while (i <= j) {
      while (kmers[i] < pivot) i++;
      while (kmers[j] > pivot) j--;
      if (i <= j) {
        swap(kmers, pos, i, j);
        i++;
        j--;
      }
    }
    if (l < j) {
      stack.push(l);
      stack.push(j);
    }
    if (i < h) {
      stack.push(i);
      stack.push(h);
    }
  }
}

/**
 * @param {Uint32Array | Float64Array} a
 * @param {Uint32Array} b
 * @param {number} i
 * @param {number} j
 */
function swap(a, b, i, j) {
  const ta = a[i];
  a[i] = a[j];
  a[j] = ta;
  const tb = b[i];
  b[i] = b[j];
  b[j] = tb;
}

/**
 * Match one strand of the query against an indexed target, emitting merged
 * diagonal runs into `out`.
 *
 * For the reverse strand, pass the reverse-complemented query codes and
 * strandFlag=1; coordinates are mapped back to the original query space here.
 *
 * Restricting [qLo, qHi) processes only k-mers *starting* in that range
 * (with automatic rolling warm-up), so disjoint ranges tile the query with no
 * lost or duplicated anchors — the unit of multi-core parallelism. A run
 * crossing a range cut is emitted as two abutting collinear segments, which
 * render identically to one.
 *
 * @param {KmerIndex} index
 * @param {Uint8Array} qCodes query codes (already revcomp'd for strand 1)
 * @param {Float64Array} qStarts record boundaries of qCodes' coordinate space
 * @param {number} qTotal total query length
 * @param {Float64Array} tStarts target record boundaries
 * @param {number} tTotal total target length
 * @param {KmerOptions} opts
 * @param {0|1} strandFlag
 * @param {SegmentVecs} out
 * @param {(done: number, total: number) => void} [onProgress]
 * @param {number} [qLo] first k-mer start position to process (inclusive)
 * @param {number} [qHi] end of k-mer start positions (exclusive)
 */
export function matchStrand(index, qCodes, qStarts, qTotal, tStarts, tTotal, opts, strandFlag, out, onProgress, qLo = 0, qHi = qCodes.length) {
  const { kmers, pos, bucketStarts, k, wide, shift, mask, top, prefDiv } = index;
  const { maxGap, minRunLen } = opts;
  // maxOcc here counts *index entries* per k-mer group (the worker translates
  // user intent — original-target occurrences and the anchor budget — into
  // this number via pickMaxOcc).
  const maxOcc = Math.max(1, Math.floor(opts.maxOcc));
  const qSample = Math.max(1, opts.qSample ?? 1);
  // Densest possible anchor spacing along a diagonal under two-sided sampling;
  // holes up to this size are bookkeeping, not sequence difference.
  const sampleHole = qSample * Math.max(1, opts.stride || 1) - 1;
  const n = qCodes.length;
  if (qTotal + tTotal >= 2 ** 32 - 2) {
    throw new Error('Combined sequence length too large for in-browser matching — import a minimap2 PAF instead.');
  }

  // Chunk-cut awareness, active only when the caller tracks edge flags
  // (pool workers): a run near enough to a cut that its continuation may
  // live in the neighboring chunk is emitted even below minRunLen and
  // flagged, so the assembler can stitch across cuts and re-filter — the
  // assembled result is then segment-for-segment faithful to one core.
  const edgeVec = out.edge;
  const edgeBridge = maxGap + sampleHole;
  const edgeLo = edgeVec && qLo > 0 ? qLo + edgeBridge : -1;
  const edgeHi = edgeVec && qHi < n ? qHi - 1 - edgeBridge : Infinity;

  // Active-run table: open-addressed, keyed by diagonal (p - t + tTotal + 1; 0 = empty).
  let cap = 1 << 16;
  let capMask = cap - 1;
  let used = 0;
  let keys = new Uint32Array(cap);
  let runQ0 = new Uint32Array(cap); // first query k-mer start of the run
  let runQ1 = new Uint32Array(cap); // last query k-mer start of the run
  let runT0 = new Uint32Array(cap); // target k-mer start matching runQ0
  let runGap = new Uint32Array(cap); // total bridged bases in the run
  let runQEnd = new Uint32Array(cap); // end of the query record the run lives in
  let runTEnd = new Uint32Array(cap); // end of the target record the run lives in

  /**
   * @param {number} q0 @param {number} q1 @param {number} t0 @param {number} gaps
   */
  const emit = (q0, q1, t0, gaps) => {
    const len = q1 - q0 + k;
    const atEdge = q0 <= edgeLo || q1 >= edgeHi;
    if (len < minRunLen && !atEdge) return;
    if (out.x.n >= MAX_SEGMENTS) {
      throw new Error(
        'Too many match segments (16M wall) — raise min match length, restore an occurrence ' +
          'cap or sampling, or zoom in. The heatmap and multiplicity lane show full repeat ' +
          'depth without enumerating it.',
      );
    }
    out.x.push(t0);
    out.y.push(strandFlag === 0 ? q0 : qTotal - q1 - k);
    out.dx.push(len);
    out.dy.push(len);
    out.strand.push(strandFlag);
    out.identity.push((len - gaps) / len);
    if (edgeVec) edgeVec.push(atEdge ? 1 : 0);
  };

  const grow = () => {
    const oldCap = cap;
    cap <<= 1;
    capMask = cap - 1;
    const nk = new Uint32Array(cap);
    const nq0 = new Uint32Array(cap);
    const nq1 = new Uint32Array(cap);
    const nt0 = new Uint32Array(cap);
    const ng = new Uint32Array(cap);
    const nqe = new Uint32Array(cap);
    const nte = new Uint32Array(cap);
    for (let i = 0; i < oldCap; i++) {
      const key = keys[i];
      if (key === 0) continue;
      let j = (Math.imul(key, 0x9e3779b1) >>> 0) & capMask;
      while (nk[j] !== 0) j = (j + 1) & capMask;
      nk[j] = key;
      nq0[j] = runQ0[i];
      nq1[j] = runQ1[i];
      nt0[j] = runT0[i];
      ng[j] = runGap[i];
      nqe[j] = runQEnd[i];
      nte[j] = runTEnd[i];
    }
    keys = nk;
    runQ0 = nq0;
    runQ1 = nq1;
    runT0 = nt0;
    runGap = ng;
    runQEnd = nqe;
    runTEnd = nte;
  };

  /** End (exclusive) of the target record containing position t. */
  const tRecEnd = (/** @type {number} */ t) => {
    let lo = 0;
    let hi = tStarts.length - 1;
    // first boundary strictly greater than t
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tStarts[mid + 1] > t) hi = mid;
      else lo = mid + 1;
    }
    return tStarts[lo + 1];
  };

  /**
   * Feed one anchor (query pos p matches target pos t) into the run-merger.
   * Runs never extend across a record boundary on either axis — a match
   * belongs to exactly one sequence pair.
   * @param {number} p @param {number} t @param {number} qEnd
   */
  const addAnchor = (p, t, qEnd) => {
    const key = p - t + tTotal + 1; // >= 1, < 2^32
    let j = (Math.imul(key, 0x9e3779b1) >>> 0) & capMask;
    for (;;) {
      const kj = keys[j];
      if (kj === key) {
        const gap = p - runQ1[j] - 1;
        if (gap <= maxGap + sampleHole && p < runQEnd[j] && t < runTEnd[j]) {
          runQ1[j] = p;
          const realGap = gap - sampleHole;
          runGap[j] += realGap > 0 ? realGap : 0;
        } else {
          emit(runQ0[j], runQ1[j], runT0[j], runGap[j]);
          runQ0[j] = p;
          runQ1[j] = p;
          runT0[j] = t;
          runGap[j] = 0;
          runQEnd[j] = qEnd;
          runTEnd[j] = tRecEnd(t);
        }
        return;
      }
      if (kj === 0) {
        keys[j] = key;
        runQ0[j] = p;
        runQ1[j] = p;
        runT0[j] = t;
        runGap[j] = 0;
        runQEnd[j] = qEnd;
        runTEnd[j] = tRecEnd(t);
        if (++used > (cap * 3) >> 2) grow();
        return;
      }
      j = (j + 1) & capMask;
    }
  };

  // Roll over the query (warm the k-mer window up before qLo).
  const startI = Math.max(0, qLo - (k - 1));
  const endI = Math.min(n, qHi + k - 1);
  let kmer = 0;
  let run = 0;
  let rec = 1;
  while (rec < qStarts.length - 1 && qStarts[rec] <= startI) rec++;
  let memoKmer = -1;
  let memoLo = 0;
  let memoHi = 0;
  for (let i = startI; i < endI; i++) {
    while (i >= qStarts[rec]) {
      rec++;
      run = 0;
    }
    const c = qCodes[i];
    if (c < 4) {
      if (wide) {
        const hi2 = Math.floor(kmer / top);
        kmer = (kmer - hi2 * top) * 4 + c;
      } else {
        kmer = (((kmer << 2) | c) & mask) >>> 0;
      }
      run++;
    } else {
      run = 0;
    }
    if (onProgress && (i & (PROGRESS_EVERY - 1)) === 0) onProgress(i - startI, endI - startI);
    if (run >= k) {
      const p = i - k + 1;
      if (p < qLo) continue;
      if (qSample > 1 && p % qSample !== 0) continue;
      let lo;
      let hi;
      if (kmer === memoKmer) {
        lo = memoLo;
        hi = memoHi;
      } else {
        const b = wide ? Math.floor(kmer / prefDiv) : kmer >>> shift;
        const be = bucketStarts[b + 1];
        lo = lowerBound(kmers, bucketStarts[b], be, kmer);
        // Upper bound by binary search too: satellite k-mers can occur 10^5+
        // times, and a linear group scan per query position turns centromeres
        // into tar pits (found the hard way on CHM13 chr17).
        hi = lo < be && kmers[lo] === kmer ? upperBound(kmers, lo, be, kmer) : lo;
        memoKmer = kmer;
        memoLo = lo;
        memoHi = hi;
      }
      const occ = hi - lo;
      if (occ > 0 && occ <= maxOcc) {
        const qEnd = qStarts[rec];
        for (let j = lo; j < hi; j++) addAnchor(p, pos[j], qEnd);
      }
    }
  }

  // Flush all live runs.
  for (let j = 0; j < cap; j++) {
    if (keys[j] !== 0) emit(runQ0[j], runQ1[j], runT0[j], runGap[j]);
  }
}

/**
 * Estimated anchor pairs one strand will enumerate at an effective cap —
 * the same occ² volume model pickMaxOcc budgets with, summed over the
 * classes the cap admits (the ≥1024 tail bin included once the cap clears
 * it). This is what lets a compute predict "quadratic satellite grind"
 * BEFORE matching starts instead of hitting the segment wall after minutes.
 *
 * @param {KmerIndex} index
 * @param {number} maxOccEntries effective per-group entry cap (Infinity = none)
 * @param {number} scale qLen·stride / tLen / qSample (see pickMaxOcc)
 */
export function estimateAnchors(index, maxOccEntries, scale) {
  let est = 0;
  for (let o = 1; o <= 1024; o++) {
    if (o > maxOccEntries) break;
    est += index.occSumSq[o] * scale;
  }
  return est;
}

/**
 * Where the repeat cutoff actually bit: merged target intervals in which most
 * indexed k-mers belong to groups *over* the effective occurrence cap — i.e.
 * regions whose matches were never enumerated at all. Without this, "no
 * similarity" and "similarity too deep to enumerate" render as the same empty
 * square, the classic dot-plot lie in satellite DNA (for period < k no budget
 * can fix it: chr9 HSat3 would need ~10^14 anchor pairs).
 *
 * A tile of `tileBp` bases is saturated when at least half of its index
 * entries are over-cap — self-normalizing across stride, N runs, and record
 * boundaries. One pass over the index, same shape as the occurrence-histogram
 * pass in buildIndex.
 *
 * @param {KmerIndex} index
 * @param {number} maxOccEntries effective per-group entry cap (post-stride)
 * @param {number} tLen total target length in bp (positions are global)
 * @param {number} [tileBp]
 * @returns {Float64Array} merged [start, end) pairs in bp, ascending
 */
export function saturatedIntervals(index, maxOccEntries, tLen, tileBp = 512) {
  const nTiles = Math.max(1, Math.ceil(tLen / tileBp));
  const over = new Uint32Array(nTiles);
  const total = new Uint32Array(nTiles);
  const { kmers, pos, bucketStarts } = index;
  const nBuckets = bucketStarts.length - 1;
  for (let b = 0; b < nBuckets; b++) {
    const hiB = bucketStarts[b + 1];
    let g = bucketStarts[b];
    while (g < hiB) {
      const kv = kmers[g];
      let e = g + 1;
      while (e < hiB && kmers[e] === kv) e++;
      const capped = e - g > maxOccEntries;
      for (let j = g; j < e; j++) {
        const t = (pos[j] / tileBp) | 0;
        total[t]++;
        if (capped) over[t]++;
      }
      g = e;
    }
  }
  /** @type {number[]} */
  const out = [];
  let runStart = -1;
  for (let t = 0; t < nTiles; t++) {
    const sat = total[t] > 0 && over[t] * 2 >= total[t];
    if (sat && runStart < 0) runStart = t;
    if (!sat && runStart >= 0) {
      out.push(runStart * tileBp, t * tileBp);
      runStart = -1;
    }
  }
  if (runStart >= 0) out.push(runStart * tileBp, Math.min(tLen, nTiles * tileBp));
  return Float64Array.from(out);
}

/**
 * Per-tile k-mer multiplicity profile of the indexed target: the repeat
 * structure at every level, not just the over-cap verdict. For each tile,
 * the geometric mean of the estimated true copy number of its k-mers and
 * the fraction that are unique in the index. Copy estimate per group:
 * (occ − 1) · stride + 1 — exact at stride 1, unbiased at the unique end
 * (a single sampled entry stays 1×, not stride×), →occ·stride for deep
 * repeats. One pass over the index, cap-independent.
 *
 * @param {KmerIndex} index
 * @param {number} tLen total target length in bp
 * @param {number} [tileBp]
 * @returns {{tileBp: number, mult: Float32Array, uniqFrac: Float32Array}}
 *   mult[t] = 0 for tiles with no indexed k-mers (N runs)
 */
export function multiplicityProfile(index, tLen, tileBp = 512) {
  const nTiles = Math.max(1, Math.ceil(tLen / tileBp));
  const sumLog = new Float64Array(nTiles);
  const cnt = new Uint32Array(nTiles);
  const uniq = new Uint32Array(nTiles);
  const stride = index.stride || 1;
  const { kmers, pos, bucketStarts } = index;
  const nBuckets = bucketStarts.length - 1;
  for (let b = 0; b < nBuckets; b++) {
    const hiB = bucketStarts[b + 1];
    let g = bucketStarts[b];
    while (g < hiB) {
      const kv = kmers[g];
      let e = g + 1;
      while (e < hiB && kmers[e] === kv) e++;
      const occ = e - g;
      const lg = Math.log2((occ - 1) * stride + 1);
      for (let j = g; j < e; j++) {
        const t = (pos[j] / tileBp) | 0;
        sumLog[t] += lg;
        cnt[t]++;
        if (occ === 1) uniq[t]++;
      }
      g = e;
    }
  }
  const mult = new Float32Array(nTiles);
  const uniqFrac = new Float32Array(nTiles);
  for (let t = 0; t < nTiles; t++) {
    if (cnt[t] > 0) {
      mult[t] = Math.pow(2, sumLog[t] / cnt[t]);
      uniqFrac[t] = uniq[t] / cnt[t];
    }
  }
  return { tileBp, mult, uniqFrac };
}

/**
 * Replace the [lo, hi) span of a sorted interval list with new intervals
 * (already confined to that span) — how a window refine's saturation result
 * updates the whole-plot picture, since its looser cap may de-saturate the
 * window. Intervals crossing the span boundary are truncated; touching
 * neighbors merge.
 *
 * @param {Float64Array} existing sorted non-overlapping [start, end) pairs
 * @param {number} lo @param {number} hi
 * @param {Float64Array} replacement pairs within [lo, hi)
 * @returns {Float64Array}
 */
export function spliceIntervals(existing, lo, hi, replacement) {
  /** @type {number[]} */
  const merged = [];
  /** @param {number} s @param {number} e */
  const push = (s, e) => {
    if (e <= s) return;
    if (merged.length > 0 && s <= merged[merged.length - 1]) {
      if (e > merged[merged.length - 1]) merged[merged.length - 1] = e;
      return;
    }
    merged.push(s, e);
  };
  let r = 0;
  let emittedNew = false;
  const emitNew = () => {
    if (emittedNew) return;
    emittedNew = true;
    while (r < replacement.length) {
      push(Math.max(lo, replacement[r]), Math.min(hi, replacement[r + 1]));
      r += 2;
    }
  };
  for (let i = 0; i < existing.length; i += 2) {
    const s = existing[i];
    const e = existing[i + 1];
    if (e <= lo) {
      push(s, e);
    } else if (s >= hi) {
      emitNew();
      push(s, e);
    } else {
      // Overlaps the span: keep only the parts outside it.
      push(s, Math.min(e, lo));
      emitNew();
      push(Math.max(s, hi), e);
    }
  }
  emitNew();
  return Float64Array.from(merged);
}

/**
 * Choose the largest per-group entry cap whose estimated anchor volume fits
 * the budget. Estimate: a group with `occ` index entries represents
 * ~occ*stride true target occurrences, so its k-mer is hit by
 * ~occ*stride * qLen/tLen sampled query positions, each emitting occ
 * anchors -> occ^2 * stride scaling (occSumSq counts post-stride entries).
 *
 * The histogram's last class bins everything >= 1024 together, so when the
 * walk accepts that final bin the WHOLE tail's volume fits the budget and
 * the user's cap is honored in full — including Infinity, which is how
 * "skip k-mers: off" becomes genuinely no occurrence masking (the anchor
 * budget stays as the volume guard and tightens only when it must, which
 * the result note and saturation hatch then disclose).
 *
 * @param {KmerIndex} index
 * @param {number} qLen query bases scanned per strand
 * @param {number} tLen target bases represented by the index (pre-stride)
 * @param {number} qSample query sampling interval
 * @param {number} userCapEntries hard upper bound (user maxOcc / stride;
 *   Infinity = no occurrence cap requested)
 * @param {number} [budget] anchors per strand
 */
export function pickMaxOcc(index, qLen, tLen, qSample, userCapEntries, budget = 60e6) {
  const scale = (qLen * (index.stride || 1)) / Math.max(tLen, 1) / Math.max(qSample, 1);
  const cap = userCapEntries === Infinity ? Infinity : Math.max(1, Math.floor(userCapEntries));
  let acc = 0;
  let chosen = 1;
  for (let o = 1; o <= 1024; o++) {
    if (o > cap) break;
    const add = index.occSumSq[o] * scale;
    if (acc + add > budget && o > 4) break;
    acc += add;
    chosen = o;
  }
  // Accepted the >=1024 bin: nothing was excluded by budget, honor the cap
  // as asked (finite values above 1024 included, or Infinity for "off").
  if (chosen === 1024) return cap;
  return chosen;
}

/**
 * First index in [lo, hi) whose value is >= x.
 * @param {Uint32Array | Float64Array} a @param {number} lo @param {number} hi @param {number} x
 */
function lowerBound(a, lo, hi, x) {
  while (lo < hi) {
    const mid = lo + ((hi - lo) >>> 1);
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * First index in [lo, hi) whose value is > x.
 * @param {Uint32Array | Float64Array} a @param {number} lo @param {number} hi @param {number} x
 */
function upperBound(a, lo, hi, x) {
  while (lo < hi) {
    const mid = lo + ((hi - lo) >>> 1);
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
