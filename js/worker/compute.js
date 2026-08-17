// @ts-check
/**
 * Compute worker: parsing, indexing and matching run here so the UI thread
 * never blocks. Result arrays are transferred (zero-copy) back to the main
 * thread; catalogs are cloned, never transferred, so the parse cache below
 * stays valid across requests. Cancellation is handled by the main thread
 * terminating and respawning the worker — no cooperative flags needed.
 */
import { parseFasta, mergeParsedFasta } from '../io/fasta.js';
import { maybeGunzip } from '../io/compress.js';
import { parsePaf, parsePafOnto } from '../io/paf.js';
import { buildIndex, matchStrand, pickMaxOcc, pickDensity, saturatedIntervals, multiplicityProfile, KMER_DEFAULTS } from '../core/kmer.js';
import { reverseComplement } from '../core/dna.js';
import { newSegmentVecs, vecsToSegments, segmentBuffers } from '../core/types.js';

/** @typedef {import('../core/types.js').PlotData} PlotData */

const post = /** @type {(msg: unknown, transfer?: Transferable[]) => void} */ (
  /** @type {any} */ (self).postMessage.bind(self)
);

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

self.onmessage = async (ev) => {
  const req = /** @type {any} */ (ev).data;
  try {
    if (req.type === 'kmer') await handleKmer(req);
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
};

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

/** @param {{id:number, gen?:number, target:ArrayBuffer[]|ArrayBuffer|null, query:ArrayBuffer[]|ArrayBuffer|null, opts:object, window?:RefineWindow}} req */
async function handleKmer(req) {
  const t0 = performance.now();
  /** @type {{catalog: any, codes: Uint8Array}} */
  let tParsed;
  /** @type {{catalog: any, codes: Uint8Array} | null} */
  let qBase;
  if (!req.target) {
    if (parsedCache && parsedCache.gen === req.gen) {
      tParsed = parsedCache.tParsed;
      qBase = parsedCache.qParsed;
    } else {
      post({ id: req.id, type: 'needData', gen: req.gen });
      return;
    }
  } else {
    progress(req.id, 'Reading files', 0);
    tParsed = await parseSlot(req.target, 'target');
    qBase = req.query ? await parseSlot(req.query, 'query') : null;
    parsedCache = { gen: req.gen ?? -1, tParsed, qParsed: qBase };
  }
  const qParsed = qBase ?? selfPlotView(tParsed);
  computeKmer(req.id, tParsed, qParsed, req.opts, t0, req.window ?? null);
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
 */
function computeKmer(id, tParsed, qParsed, optsIn, t0, window = null) {
  const opts = { ...KMER_DEFAULTS, ...optsIn };
  // Keep the index within ~48M entries on big targets by striding, and cap
  // query-side lookups the same way — random-access lookups are the wall at
  // chromosome scale, and run merging bridges the sampling holes. All auto
  // values derive from the *worked* extent, so a refine window computes at
  // full density even when the whole chromosome would not. 'off' is TRUE
  // full density on both axes (or a refusal — never a silent stride).
  const tLenEff = window ? Math.max(1, window.tx1 - window.tx0) : tParsed.codes.length;
  const qLenEff = window ? Math.max(1, window.qy1 - window.qy0) : qParsed.codes.length;
  const { stride, qSample } = pickDensity(
    /** @type {'auto'|'off'|number|undefined} */ (opts.sample),
    Math.max(1, opts.stride),
    tLenEff,
    qLenEff,
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
  // are what melt genome-scale runs.
  const userCapEntries = Math.max(1, Math.floor(opts.maxOcc / stride));
  // Explicit refines may carry a raised anchor budget (opts.budgetX): the
  // user asked for depth, so the repeat cutoff loosens accordingly.
  const maxOccEff = pickMaxOcc(
    index, qLenEff, tLenEff, qSample, userCapEntries,
    60e6 * (/** @type {any} */ (opts).budgetX || 1),
  );
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
  const samplingNote =
    stride > 1 || qSample > 1 || maxOccEff < userCapEntries
      ? `large input: sampling 1/${stride} target k-mers, 1/${qSample} query positions; ` +
        `repeat cutoff ${maxOccEff * stride}× (auto${budgetX > 1 ? `, budget ${budgetX}×` : ''})`
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
  const note = [samplingNote, capNote, satNote].filter(Boolean).join(' · ');

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
    { id: req.id, type: 'overlayResult', segments: r.segments, skipped: r.skipped, unknown: r.unknown },
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
