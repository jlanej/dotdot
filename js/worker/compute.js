// @ts-check
/**
 * Compute worker: parsing, indexing and matching run here so the UI thread
 * never blocks. Result arrays are transferred (zero-copy) back to the main
 * thread; catalogs are cloned, never transferred, so the parse cache below
 * stays valid across requests. Cancellation is handled by the main thread
 * terminating and respawning the worker — no cooperative flags needed.
 */
import { parseFasta, mergeParsedFasta, looksLikeFasta } from '../io/fasta.js';
import { maybeGunzip } from '../io/compress.js';
import { parsePaf, parsePafOnto, looksLikePaf } from '../io/paf.js';
import { buildIndex, matchStrand, pickMaxOcc, pickDensity, estimateAnchors, anchorScale, saturatedIntervals, multiplicityProfile, containmentGrid, KMER_DEFAULTS, EXACT_MAX_BP, EXACT_HARD_BP } from '../core/kmer.js';
import { reverseComplement } from '../core/dna.js';
import { newSegmentVecs, vecsToSegments, segmentBuffers } from '../core/types.js';

/** @typedef {import('../core/types.js').PlotData} PlotData */

/**
 * Message sink: the worker's postMessage, bound LAZILY so this module can
 * be imported outside a worker — the consent gates and cache protocol are
 * unit-tested in Deno, where self.postMessage does not exist. Tests swap
 * it with setPostForTesting().
 * @type {(msg: unknown, transfer?: Transferable[]) => void}
 */
let post = (msg, transfer) => {
  const pm = /** @type {any} */ (self).postMessage;
  if (typeof pm !== 'function') {
    throw new Error('No postMessage in this context — tests must call setPostForTesting().');
  }
  post = pm.bind(self);
  post(msg, transfer);
};

/** Test hook: capture outbound messages instead of posting to a port. */
export function setPostForTesting(/** @type {(msg: unknown, transfer?: Transferable[]) => void} */ fn) {
  post = fn;
}

/** Test hook: drop the parse cache so each test case starts cold. */
export function resetParsedCacheForTesting() {
  parsedCache = null;
}

let lastProgressAt = 0;

/**
 * @param {number} id @param {string} phase @param {number} frac
 */
function progress(id, phase, frac) {
  const now = performance.now();
  if (frac < 1 && now - lastProgressAt < 80) return;
  lastProgressAt = now;
  post({ id, type: 'progress', phase, frac });
}

/**
 * Handle one request message. Exported so tests can drive the worker's
 * gates (consent thresholds, needData protocol, parse-warning notes)
 * directly, without a Worker.
 * @param {any} req
 */
export async function handleRequest(req) {
  try {
    if (req.type === 'kmer') await handleKmer(req);
    else if (req.type === 'containment') await handleContainment(req);
    else if (req.type === 'paf') await handlePaf(req);
    else if (req.type === 'pafOverlay') await handlePafOverlay(req);
    else throw new Error(`Unknown request type: ${req?.type}`);
  } catch (err) {
    post({
      id: req?.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
self.onmessage = (ev) => void handleRequest(/** @type {any} */ (ev).data);

/**
 * @typedef {{tx0:number, tx1:number, qy0:number, qy1:number}} RefineWindow
 * Global-coordinate window for a region-refine pass: only target k-mers
 * starting in [tx0,tx1) are indexed and only query positions in [qy0,qy1)
 * are matched, at full density.
 */

/**
 * Parsed-input cache. Main stamps every kmer request with its data
 * generation; a matching generation arrives with `target: null` and skips
 * the clone + gunzip + parse entirely — Recompute and Refine become
 * options-only messages. A generation miss without data asks main to
 * resend ('needData').
 * @type {{gen: number, tParsed: {catalog: any, codes: Uint8Array}, qParsed: {catalog: any, codes: Uint8Array} | null} | null}
 */
let parsedCache = null;

/** @typedef {{catalog: any, codes: Uint8Array, warnings?: string[]}} ParsedSlot */

/**
 * Resolve a request's parsed inputs through the generation cache — the one
 * preamble both kmer and containment requests share. Cached generation →
 * reuse; fresh buffers → parse and cache; a miss without buffers asks main
 * to resend ('needData') and returns null (the caller just returns).
 * @param {{id:number, gen?:number, target:ArrayBuffer[]|ArrayBuffer|null, query:ArrayBuffer[]|ArrayBuffer|null}} req
 * @returns {Promise<{tParsed: ParsedSlot, qBase: ParsedSlot | null} | null>}
 */
async function resolveParsed(req) {
  if (!req.target) {
    if (parsedCache && parsedCache.gen === req.gen) {
      return { tParsed: parsedCache.tParsed, qBase: parsedCache.qParsed };
    }
    post({ id: req.id, type: 'needData', gen: req.gen });
    return null;
  }
  progress(req.id, 'Reading files', 0);
  const tParsed = await parseSlot(req.target, 'target');
  const qBase = req.query ? await parseSlot(req.query, 'query') : null;
  parsedCache = { gen: req.gen ?? -1, tParsed, qParsed: qBase };
  return { tParsed, qBase };
}

/** @param {{id:number, gen?:number, target:ArrayBuffer[]|ArrayBuffer|null, query:ArrayBuffer[]|ArrayBuffer|null, opts:object, window?:RefineWindow}} req */
async function handleKmer(req) {
  const t0 = performance.now();
  const parsed = await resolveParsed(req);
  if (!parsed) return;
  const { tParsed, qBase } = parsed;
  const qParsed = qBase ?? selfPlotView(tParsed);
  // Parser warnings (duplicate names, swallowed headers, empty records)
  // ride the result note — suspicious inputs are disclosed, never silent.
  const parseNotes = [...(tParsed.warnings ?? []), ...(qBase?.warnings ?? [])];
  computeKmer(req.id, tParsed, qParsed, req.opts, t0, req.window ?? null, parseNotes);
}

/**
 * Parse one axis slot: one or many FASTA buffers (multi-file axes), each
 * gunzipped and parsed independently, merged into a single catalog.
 * @param {ArrayBuffer[] | ArrayBuffer} bufs @param {string} slot
 */
async function parseSlot(bufs, slot) {
  const list = Array.isArray(bufs) ? bufs : [bufs];
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const bytes = await maybeGunzip(new Uint8Array(list[i]));
    const label = list.length > 1 ? `${slot} file ${i + 1}` : slot;
    // A gzipped PAF whose name lacks ".paf" sails past the extension check
    // and would parse as an all-N "FASTA" — an empty plot with no error.
    // Sniff the DECOMPRESSED bytes and say what actually happened.
    if (!looksLikeFasta(bytes) && looksLikePaf(bytes)) {
      throw new Error(
        `The ${label} looks like a PAF alignment file — load it with the Aligner PAF button, ` +
          'or drop it onto an existing plot as the audit overlay.',
      );
    }
    parts.push(parseFasta(bytes, list.length > 1 ? `${slot}${i + 1}` : slot));
  }
  return mergeParsedFasta(parts);
}

/**
 * Self dot plot: same codes, a fresh catalog clone per request so the two
 * axes stay independent objects.
 * @param {{catalog: any, codes: Uint8Array}} tParsed
 */
function selfPlotView(tParsed) {
  /** @type {any} */
  const clone = {
    names: tParsed.catalog.names.slice(),
    starts: tParsed.catalog.starts.slice(),
    total: tParsed.catalog.total,
  };
  if (tParsed.catalog.offsets) clone.offsets = tParsed.catalog.offsets.slice();
  return { catalog: clone, codes: tParsed.codes };
}

/**
 * @param {number} id
 * @param {{catalog: any, codes: Uint8Array}} tParsed
 * @param {{catalog: any, codes: Uint8Array}} qParsed
 * @param {object & {sample?: 'auto'|'off'|number}} optsIn
 * @param {number} t0
 * @param {RefineWindow | null} [window]
 * @param {string[]} [parseNotes] parser warnings to surface in the note
 */
function computeKmer(id, tParsed, qParsed, optsIn, t0, window = null, parseNotes = []) {
  const opts = { ...KMER_DEFAULTS, ...optsIn };
  // Keep the index within ~48M entries on big targets by striding, and cap
  // query-side lookups the same way — random-access lookups are the wall at
  // chromosome scale, and run merging bridges the sampling holes. All auto
  // values derive from the *worked* extent, so a refine window computes at
  // full density even when the whole chromosome would not. 'off' is TRUE
  // full density on both axes (or a refusal — never a silent stride).
  const tLenEff = window ? Math.max(1, window.tx1 - window.tx0) : tParsed.codes.length;
  const qLenEff = window ? Math.max(1, window.qy1 - window.qy0) : qParsed.codes.length;
  // Exact mode is unbounded by policy, bounded by consent: over the default
  // (or pre-approved "off 512M") threshold, ask the user with the real RAM
  // number instead of refusing — the confirmed resubmit is an options-only
  // message, the parse cache keeps it free. Only the allocation wall is a
  // hard no: past ~1 Gb the proceed button would just be an OOM button.
  if (opts.sample === 'off') {
    if (tLenEff > EXACT_HARD_BP) {
      throw new Error(
        `Exact mode on ${Math.round(tLenEff / 1e6)} Mb is past the ${EXACT_HARD_BP / 1e6} Mb ` +
          'engine allocation limit — zoom in and Refine the window instead.',
      );
    }
    const consent = /** @type {number|undefined} */ (/** @type {any} */ (opts).exactMaxBp) || EXACT_MAX_BP;
    if (tLenEff > consent && !(/** @type {any} */ (opts).exactConfirmed)) {
      post({
        id,
        type: 'confirmExact',
        tLenBp: tLenEff,
        gbLo: (tLenEff * 8) / 1e9,
        gbHi: (tLenEff * 12) / 1e9,
      });
      return;
    }
  }
  const { stride, qSample } = pickDensity(
    /** @type {'auto'|'off'|number|undefined} */ (opts.sample),
    Math.max(1, opts.stride),
    tLenEff,
    qLenEff,
    tLenEff, // consent already granted above; the engine wall still backstops
  );

  const qTotal = qParsed.catalog.total;
  const tTotal = tParsed.catalog.total;
  const tStarts = tParsed.catalog.starts;
  const qLo = window ? Math.max(0, Math.floor(window.qy0)) : 0;
  const qHi = window ? Math.min(qParsed.codes.length, Math.ceil(window.qy1)) : qParsed.codes.length;

  // Multi-core decision up front so the index can be born in shared memory
  // instead of built private then copied. Refine windows pool too — their
  // full density is exactly where the cores matter.
  const cores = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
  const isolated =
    typeof SharedArrayBuffer !== 'undefined' && /** @type {any} */ (self).crossOriginIsolated === true;
  const pooled = isolated && cores >= 2 && qHi - qLo > 4_000_000;
  const wideK = opts.k > 16;
  /** @type {((kind: 'kmers'|'pos'|'buckets', len: number) => Uint32Array|Float64Array) | undefined} */
  const alloc = pooled
    ? (kind, len) =>
        kind === 'kmers' && wideK
          ? new Float64Array(new SharedArrayBuffer(len * 8))
          : new Uint32Array(new SharedArrayBuffer(len * 4))
    : undefined;

  progress(id, 'Indexing target', 0);
  const index = buildIndex(
    tParsed.codes,
    tStarts,
    opts.k,
    stride,
    (d, t) => progress(id, 'Indexing target', d / t),
    window ? Math.max(0, Math.floor(window.tx0)) : 0,
    window ? Math.min(tParsed.codes.length, Math.ceil(window.tx1)) : tParsed.codes.length,
    alloc,
  );

  // Translate the user's occurrence cap (original-target semantics) into an
  // index-entry cap, then tighten it against the anchor budget using the
  // index's own occurrence histogram — repeat families, not sequence length,
  // are what melt genome-scale runs. Infinity = "off": no occurrence
  // masking; only the anchor budget may tighten, and says so when it does.
  const userCapEntries = Number.isFinite(opts.maxOcc)
    ? Math.max(1, Math.floor(opts.maxOcc / stride))
    : Infinity;
  // Explicit refines may carry a raised anchor budget (opts.budgetX): the
  // user asked for depth, so the repeat cutoff loosens accordingly.
  const maxOccEff = pickMaxOcc(
    index, qLenEff, tLenEff, qSample, userCapEntries,
    60e6 * (/** @type {any} */ (opts).budgetX || 1),
  );
  // Anchor-volume pre-flight: with the caps loosened or off, satellite
  // windows go quadratic. The histogram predicts the grind — ask before
  // matching starts, not after minutes at the segment wall. Two triggers:
  // anchor TIME (the quadratic grind) and run-table RAM (each distinct
  // diagonal costs ~28 B live — background anchors at low k land on
  // mostly-distinct diagonals, and nothing else bounds that table).
  {
    const scale = anchorScale(index, qLenEff, tLenEff, qSample);
    const estTotal = 2 * estimateAnchors(index, maxOccEff, scale); // both strands
    // With a finite cap past the histogram's 1024-entry tail bin, the tail's
    // full occ² mass is included even for groups the cap will trim — the
    // estimate becomes an upper bound and the dialog must say so.
    const estUpper = Number.isFinite(maxOccEff) && maxOccEff > 1023;
    // Distinct diagonals ≤ min(anchors, window diagonal count); open
    // addressing doubles at 3/4 load, so live bytes ≈ diagonals × 28 × 8/3.
    const diagBound = Math.min(estTotal / 2, tLenEff + qLenEff);
    const tableGb = (diagBound * 28 * (8 / 3)) / 1e9;
    if ((estTotal > 2e9 || tableGb > 2) && !(/** @type {any} */ (opts).volumeConfirmed)) {
      post({
        id,
        type: 'confirmVolume',
        estAnchors: estTotal,
        estUpper,
        tableGb: tableGb > 1 ? Math.round(tableGb * 10) / 10 : 0,
        tLenBp: tLenEff,
      });
      return;
    }
  }
  // Sampled runs cannot represent one- or two-anchor matches faithfully
  // anyway (sub-pixel at this scale) — require a few co-linear anchors of
  // evidence instead of letting tens of millions of repeat fragments exhaust
  // the segment budget.
  const sampleSpacing = qSample * stride;
  const minRunLen =
    sampleSpacing > 1 ? Math.max(opts.minRunLen, opts.k + 3 * sampleSpacing) : opts.minRunLen;
  const effOpts = { ...opts, stride, qSample, maxOcc: maxOccEff, minRunLen };
  // Where the cutoff actually bit: target intervals whose k-mers were mostly
  // over-cap and therefore never enumerated. Shipped with the stats so the
  // display can hatch them — an empty square there means "not searched",
  // not "not similar".
  const saturated = saturatedIntervals(index, maxOccEff, tParsed.codes.length);
  let satBp = 0;
  for (let i = 0; i < saturated.length; i += 2) satBp += saturated[i + 1] - saturated[i];
  // Cap-independent repeat topology along the target — feeds the k-mer
  // multiplicity axis lane (blank = unique-anchor territory). Skipped for
  // refine windows: the lane keeps the whole-plot profile.
  const profile = window ? undefined : multiplicityProfile(index, tParsed.codes.length);
  /** @type {import('../core/types.js').KmerStats} */
  const kmerStats = {
    k: opts.k,
    stride,
    qSample,
    maxOcc: maxOccEff * stride,
    entries: index.pos.length,
    distinct: (() => {
      let n = 0;
      for (let o = 1; o < index.occCount.length; o++) n += index.occCount[o];
      return n;
    })(),
    occCount: index.occCount,
    saturated,
    profile,
  };
  const budgetX = /** @type {any} */ (opts).budgetX || 1;
  const budgetLabel = budgetX === Infinity ? 'budget off' : `budget ${budgetX}×`;
  // With cap and budget both off the effective cutoff is Infinity — say
  // "off", never interpolate the literal Infinity into user-facing text.
  const cutoffLabel = Number.isFinite(maxOccEff)
    ? `repeat cutoff ${maxOccEff * stride}× (auto${budgetX > 1 ? `, ${budgetLabel}` : ''})`
    : 'repeat cutoff off';
  const samplingNote =
    stride > 1 || qSample > 1 || maxOccEff < userCapEntries
      ? `large input: sampling 1/${stride} target k-mers, 1/${qSample} query positions; ` +
        cutoffLabel
      : '';
  const satNote =
    satBp > 0.01 * tLenEff
      ? `${Math.round((satBp / tLenEff) * 100)}% of the target is repeats above the cutoff — ` +
        'hatched in the heatmap view, not searched'
      : '';
  // A strided index counts occurrences in sampled entries, so a cap that
  // isn't a multiple of the stride can only be enforced approximately —
  // worst at tiny caps (cap 1 at stride 2 admits some true-2× k-mers). Say
  // so instead of silently rounding.
  const capNote =
    stride > 1 && maxOccEff === userCapEntries && maxOccEff * stride !== opts.maxOcc
      ? `occurrence cap ${opts.maxOcc}× rounds to ~${maxOccEff * stride}× ` +
        `(index samples 1/${stride} target k-mers; zoom under 48 Mb and Refine for exact)`
      : '';
  const note = [...parseNotes, samplingNote, capNote, satNote].filter(Boolean).join(' · ');

  if (pooled) {
    progress(id, 'Preparing shared memory', 0.5);
    /** @param {Uint8Array} src */
    const toSharedU8 = (src) => {
      const view = new Uint8Array(new SharedArrayBuffer(src.byteLength));
      view.set(src);
      return view;
    };
    const qView = toSharedU8(qParsed.codes);
    const rcView = new Uint8Array(new SharedArrayBuffer(qParsed.codes.length));
    reverseComplement(qParsed.codes, rcView);
    // Many small chunks + work stealing on the main thread: repeat-dense
    // regions (centromeres) cost far more than their share, so equal slices
    // leave one straggler core grinding alone. Small chunks bound the tail.
    const parts = [];
    const chunk = Math.max(2_000_000, Math.ceil((qHi - qLo) / (cores * 8)));
    for (let lo = qLo; lo < qHi; lo += chunk) {
      parts.push({ qLo: lo, qHi: Math.min(qHi, lo + chunk) });
    }
    post({
      id,
      type: 'plan',
      plan: {
        parts,
        cores,
        window,
        // Everything a matcher needs, in one bundle forwarded wholesale
        // (compute -> main -> match) so a new field can't be dropped en route.
        shared: {
          qSab: qView.buffer,
          rcSab: rcView.buffer,
          kmersSab: index.kmers.buffer,
          posSab: index.pos.buffer,
          bucketsSab: index.bucketStarts.buffer,
          indexMeta: {
            k: effOpts.k,
            wide: index.wide,
            shift: index.shift,
            mask: index.mask,
            top: index.top,
            prefDiv: index.prefDiv,
            stride: index.stride,
          },
          opts: effOpts,
          qStarts: qParsed.catalog.starts,
          rcStarts: mirrorStarts(qParsed.catalog.starts),
          tStarts,
          qTotal,
          tTotal,
        },
        target: tParsed.catalog,
        query: qParsed.catalog,
        kmerStats,
        note: (note ? note + ' · ' : '') + `${Math.min(cores, parts.length)} cores`,
      },
    });
    return;
  }

  const out = newSegmentVecs(1 << 16);
  progress(id, 'Matching forward strand', 0);
  matchStrand(
    index, qParsed.codes, qParsed.catalog.starts, qTotal, tStarts, tTotal, effOpts, 0, out,
    (d, t) => progress(id, 'Matching forward strand', d / t),
    qLo, qHi,
  );

  progress(id, 'Matching reverse strand', 0);
  const rcCodes = reverseComplement(qParsed.codes);
  const rcStarts = mirrorStarts(qParsed.catalog.starts);
  // The same query window, mirrored into reverse-complement coordinates.
  matchStrand(
    index, rcCodes, rcStarts, qTotal, tStarts, tTotal, effOpts, 1, out,
    (d, t) => progress(id, 'Matching reverse strand', d / t),
    qTotal - qHi, qTotal - qLo,
  );

  progress(id, 'Building plot', 0.9);
  const segments = vecsToSegments(out);
  let identMin = 1;
  for (let i = 0; i < segments.count; i++) {
    if (segments.identity[i] < identMin) identMin = segments.identity[i];
  }
  if (window) {
    post(
      { id, type: 'regionResult', segments, window, identMin, saturated, elapsedMs: performance.now() - t0 },
      segmentBuffers(segments),
    );
    return;
  }
  /** @type {PlotData} */
  const data = {
    target: tParsed.catalog,
    query: qParsed.catalog,
    segments,
    source: 'kmer',
    stats: {
      elapsedMs: performance.now() - t0,
      identMin,
      note: note || undefined,
      kmer: kmerStats,
    },
  };
  post({ id, type: 'result', data }, segmentBuffers(data.segments));
}

/**
 * ANI heatmap request: tile-pair identity by multiset containment over the
 * visible window of a self-plot — no anchors, no occurrence cap, no trap.
 * Uses the same parse cache / needData protocol as kmer requests, builds a
 * windowed index spanning both tile ranges, and picks the tile resolution
 * from the occurrence histogram so the group walk fits a work budget.
 * @param {{id:number, gen?:number, target:ArrayBuffer[]|ArrayBuffer|null, query:ArrayBuffer[]|ArrayBuffer|null, opts:{k:number, maxN?:number, forceN?:number}, window:{tx0:number,tx1:number,qy0:number,qy1:number}}} req
 */
async function handleContainment(req) {
  const t0 = performance.now();
  const parsed = await resolveParsed(req);
  if (!parsed) return;
  const { tParsed, qBase } = parsed;
  const w = req.window;
  const k = Math.min(26, Math.max(4, Math.round(req.opts.k || 15)));
  progress(req.id, 'Indexing window', 0);
  /** @type {import('../core/kmer.js').KmerIndex} */
  let index;
  /** @type {{x0: number, x1: number, y0: number, y1: number}} */
  let tileRanges;
  // Overlapping self-plot windows share one coordinate space — one windowed
  // index over their union span covers everything. DISJOINT self windows
  // (an off-diagonal drill: 0–1 Mb vs 200–201 Mb) route through the
  // concatenation path instead: indexing the whole gap between them cost up
  // to ~100× the work and coarsened the stride exactly where the user had
  // zoomed in for detail.
  const selfOverlap = !qBase && Math.min(w.tx1, w.qy1) > Math.max(w.tx0, w.qy0);
  if (selfOverlap) {
    const lo = Math.max(0, Math.floor(Math.min(w.tx0, w.qy0)));
    const hi = Math.min(tParsed.codes.length, Math.ceil(Math.max(w.tx1, w.qy1)));
    const span = Math.max(1, hi - lo);
    // Stride subsamples both tiles' multisets identically, so the containment
    // ratio is robust to it — index budget applies as usual.
    const stride = Math.max(1, Math.ceil(span / 48_000_000));
    index = buildIndex(
      tParsed.codes, tParsed.catalog.starts, k, stride,
      (d, t) => progress(req.id, 'Indexing window', d / t), lo, hi,
    );
    tileRanges = { x0: w.tx0, x1: w.tx1, y0: w.qy0, y1: w.qy1 };
  } else {
    // Two different windows (cross-plot axes, or disjoint self windows):
    // slice both, concatenate into one local coordinate space (junction and
    // record boundaries preserved so k-mers never roll across), and index
    // that — containmentGrid then compares target tiles [0, txSpan) against
    // query tiles [txSpan, txSpan + qySpan).
    const qSrc = qBase ?? tParsed;
    const txLo = Math.max(0, Math.floor(w.tx0));
    const txHi = Math.min(tParsed.codes.length, Math.ceil(w.tx1));
    const qyLo = Math.max(0, Math.floor(w.qy0));
    const qyHi = Math.min(qSrc.codes.length, Math.ceil(w.qy1));
    const txSpan = Math.max(0, txHi - txLo);
    const qySpan = Math.max(0, qyHi - qyLo);
    const combined = new Uint8Array(txSpan + qySpan);
    combined.set(tParsed.codes.subarray(txLo, txHi), 0);
    combined.set(qSrc.codes.subarray(qyLo, qyHi), txSpan);
    /** @type {number[]} */
    const bounds = [0];
    for (const b of tParsed.catalog.starts) {
      if (b > txLo && b < txHi) bounds.push(b - txLo);
    }
    bounds.push(txSpan);
    for (const b of qSrc.catalog.starts) {
      if (b > qyLo && b < qyHi) bounds.push(b - qyLo + txSpan);
    }
    bounds.push(txSpan + qySpan);
    const starts = Float64Array.from([...new Set(bounds)].sort((a, b) => a - b));
    const stride = Math.max(1, Math.ceil(Math.max(1, combined.length) / 48_000_000));
    index = buildIndex(
      combined, starts, k, stride,
      (d, t) => progress(req.id, 'Indexing window', d / t),
    );
    tileRanges = { x0: 0, x1: txSpan, y0: txSpan, y1: txSpan + qySpan };
  }
  // Resolution by work budget: a group touching many tiles costs
  // nnz_x * nnz_y. Estimate touched tiles with the birthday bound
  // n·(1 − e^(−occ/n)) — much tighter than min(occ, n) for mid-depth
  // families — and take the finest grid under the budget, capped at what
  // the caller's viewport can display (no point out-resolving the screen).
  let n = 64;
  if (req.opts.forceN) {
    // An explicit tile count is the user's call — no budget, no display cap
    // (export-grade grids out-resolve the screen on purpose).
    n = Math.max(64, Math.min(1024, Math.round(req.opts.forceN)));
  } else {
    const maxN = Math.max(96, Math.min(1024, Math.round(req.opts.maxN || 512)));
    for (const cand of [1024, 768, 640, 512, 416, 320, 256, 192, 128, 96]) {
      if (cand > maxN) continue;
      let est = 0;
      for (let o = 1; o < index.occCount.length; o++) {
        const nnz = cand * (1 - Math.exp(-o / cand));
        est += index.occCount[o] * nnz * nnz;
      }
      if (est <= 1.2e9) {
        n = cand;
        break;
      }
    }
  }
  const { grid } = containmentGrid(
    index, tileRanges.x0, tileRanges.x1, tileRanges.y0, tileRanges.y1, n, n, k,
    (d, t) => progress(req.id, `Comparing ${n}×${n} tiles`, d / t),
  );
  post(
    {
      id: req.id,
      type: 'containResult',
      grid,
      nx: n,
      ny: n,
      window: w,
      elapsedMs: performance.now() - t0,
    },
    [grid.buffer],
  );
}

/**
 * Map an aligner's PAF onto the axes of the already-loaded plot (the audit
 * overlay). The base plot is untouched.
 * @param {{id:number, buf:ArrayBuffer, target:import('../core/types.js').AxisCatalog, query:import('../core/types.js').AxisCatalog}} req
 */
async function handlePafOverlay(req) {
  progress(req.id, 'Reading aligner file', 0);
  const bytes = await maybeGunzip(new Uint8Array(req.buf));
  progress(req.id, 'Mapping onto loaded axes', 0.4);
  const r = parsePafOnto(bytes, req.target, req.query);
  post(
    {
      id: req.id,
      type: 'overlayResult',
      segments: r.segments,
      skipped: r.skipped,
      unknown: r.unknown,
      mismatch: r.mismatch,
      remapped: r.remapped,
    },
    segmentBuffers(r.segments),
  );
}

/** @param {{id:number, buf:ArrayBuffer}} req */
async function handlePaf(req) {
  progress(req.id, 'Reading file', 0);
  const bytes = await maybeGunzip(new Uint8Array(req.buf));
  progress(req.id, 'Parsing alignments', 0.3);
  const data = parsePaf(bytes);
  post({ id: req.id, type: 'result', data }, segmentBuffers(data.segments));
}

/**
 * Record boundaries of the reverse-complemented concatenation: same lengths,
 * reversed order.
 * @param {Float64Array} starts
 */
function mirrorStarts(starts) {
  const m = starts.length - 1;
  const out = new Float64Array(m + 1);
  let acc = 0;
  for (let j = 0; j < m; j++) {
    out[j] = acc;
    acc += starts[m - j] - starts[m - j - 1];
  }
  out[m] = acc;
  return out;
}
