// @ts-check
/**
 * Compute worker: parsing, indexing and matching run here so the UI thread
 * never blocks. All result arrays are transferred (zero-copy) back to the
 * main thread. Cancellation is handled by the main thread terminating and
 * respawning the worker — no cooperative flags needed.
 */
import { parseFasta } from '../io/fasta.js';
import { maybeGunzip } from '../io/compress.js';
import { parsePaf, parsePafOnto } from '../io/paf.js';
import { buildIndex, matchStrand, pickMaxOcc, KMER_DEFAULTS } from '../core/kmer.js';
import { reverseComplement } from '../core/dna.js';
import { F64Vec, F32Vec, U8Vec } from '../core/vec.js';

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

/** @param {{id:number, target:ArrayBuffer, query:ArrayBuffer|null, opts:object, window?:RefineWindow}} req */
async function handleKmer(req) {
  const t0 = performance.now();
  progress(req.id, 'Reading files', 0);
  const tBytes = await maybeGunzip(new Uint8Array(req.target));
  const tParsed = parseFasta(tBytes, 'target');
  /** @type {{catalog: import('../core/types.js').AxisCatalog, codes: Uint8Array}} */
  let qParsed;
  if (req.query) {
    const qBytes = await maybeGunzip(new Uint8Array(req.query));
    qParsed = parseFasta(qBytes, 'query');
  } else {
    // Self dot plot — clone the catalog so transfer lists stay disjoint.
    /** @type {import('../core/types.js').AxisCatalog} */
    const clone = {
      names: tParsed.catalog.names.slice(),
      starts: tParsed.catalog.starts.slice(),
      total: tParsed.catalog.total,
    };
    if (tParsed.catalog.offsets) clone.offsets = tParsed.catalog.offsets.slice();
    qParsed = { catalog: clone, codes: tParsed.codes };
  }
  computeKmer(req.id, tParsed, qParsed, req.opts, t0, req.window ?? null);
}

/**
 * @param {number} id
 * @param {{catalog: import('../core/types.js').AxisCatalog, codes: Uint8Array}} tParsed
 * @param {{catalog: import('../core/types.js').AxisCatalog, codes: Uint8Array}} qParsed
 * @param {object & {sample?: 'auto'|number}} optsIn
 * @param {number} t0
 * @param {RefineWindow | null} [window]
 */
function computeKmer(id, tParsed, qParsed, optsIn, t0, window = null) {
  const opts = { ...KMER_DEFAULTS, ...optsIn };
  // Keep the index within ~48M entries on big targets by striding, and cap
  // query-side lookups the same way — random-access lookups are the wall at
  // chromosome scale, and run merging bridges the sampling holes. All auto
  // values derive from the *worked* extent, so a refine window computes at
  // full density even when the whole chromosome would not.
  const tLenEff = window ? Math.max(1, window.tx1 - window.tx0) : tParsed.codes.length;
  const qLenEff = window ? Math.max(1, window.qy1 - window.qy0) : qParsed.codes.length;
  const autoStride = Math.max(1, Math.ceil(tLenEff / 48_000_000));
  const stride = Math.max(opts.stride, autoStride);
  const autoQSample = Math.max(1, Math.ceil(qLenEff / 48_000_000));
  // 'auto' (or absent) follows size; an explicit number is honored exactly —
  // including 1 = full density at the user's own risk/time.
  const qSample =
    opts.sample == null || opts.sample === 'auto'
      ? autoQSample
      : Math.max(1, Math.floor(opts.sample));

  progress(id, 'Indexing target', 0);
  const index = buildIndex(
    tParsed.codes,
    tParsed.catalog.starts,
    opts.k,
    stride,
    (d, t) => progress(id, 'Indexing target', d / t),
    window ? Math.max(0, Math.floor(window.tx0)) : 0,
    window ? Math.min(tParsed.codes.length, Math.ceil(window.tx1)) : tParsed.codes.length,
  );

  // Translate the user's occurrence cap (original-target semantics) into an
  // index-entry cap, then tighten it against the anchor budget using the
  // index's own occurrence histogram — repeat families, not sequence length,
  // are what melt genome-scale runs.
  const userCapEntries = Math.max(1, Math.floor(opts.maxOcc / stride));
  const maxOccEff = pickMaxOcc(index, qLenEff, tLenEff, qSample, userCapEntries);
  // Sampled runs cannot represent one- or two-anchor matches faithfully
  // anyway (sub-pixel at this scale) — require a few co-linear anchors of
  // evidence instead of letting tens of millions of repeat fragments exhaust
  // the segment budget.
  const sampleSpacing = qSample * stride;
  const minRunLen =
    sampleSpacing > 1 ? Math.max(opts.minRunLen, opts.k + 3 * sampleSpacing) : opts.minRunLen;
  const effOpts = { ...opts, stride, qSample, maxOcc: maxOccEff, minRunLen };

  // Multi-core path: with cross-origin isolation the index and query go into
  // SharedArrayBuffers and the main thread fans matching out over CPU cores.
  // Without isolation we match inline right here — same code, one core.
  const cores = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
  const isolated =
    typeof SharedArrayBuffer !== 'undefined' && /** @type {any} */ (self).crossOriginIsolated === true;
  if (!window && isolated && cores >= 2 && qParsed.codes.length > 4_000_000) {
    progress(id, 'Preparing shared memory', 0.5);
    const qTotal = qParsed.catalog.total;
    const tTotal = tParsed.catalog.total;
    const rcCodes = reverseComplement(qParsed.codes);
    /** @param {Uint8Array | Uint32Array | Float64Array} src @param {'u8'|'u32'|'f64'} kind */
    const toSab = (src, kind) => {
      const sab = new SharedArrayBuffer(src.byteLength);
      const view =
        kind === 'u8' ? new Uint8Array(sab) : kind === 'u32' ? new Uint32Array(sab) : new Float64Array(sab);
      view.set(/** @type {any} */ (src));
      return sab;
    };
    // Many small chunks + work stealing on the main thread: repeat-dense
    // regions (centromeres) cost far more than their share, so equal slices
    // leave one straggler core grinding alone. Small chunks bound the tail.
    const parts = [];
    const chunk = Math.max(2_000_000, Math.ceil(qParsed.codes.length / (cores * 8)));
    for (let qLo = 0; qLo < qParsed.codes.length; qLo += chunk) {
      parts.push({ qLo, qHi: Math.min(qParsed.codes.length, qLo + chunk) });
    }
    post({
      id,
      type: 'plan',
      plan: {
        parts,
        cores,
        qSab: toSab(qParsed.codes, 'u8'),
        rcSab: toSab(rcCodes, 'u8'),
        kmersSab: toSab(index.kmers, index.wide ? 'f64' : 'u32'),
        posSab: toSab(index.pos, 'u32'),
        bucketsSab: toSab(index.bucketStarts, 'u32'),
        // One bundle for every scalar the matcher needs to reconstruct the
        // index — forwarded wholesale so new fields can't be dropped en route.
        indexMeta: {
          k: effOpts.k,
          wide: index.wide,
          shift: index.shift,
          mask: index.mask,
          top: index.top,
          prefDiv: index.prefDiv,
        },
        opts: effOpts,
        qStarts: qParsed.catalog.starts,
        rcStarts: mirrorStarts(qParsed.catalog.starts),
        tStarts: tParsed.catalog.starts,
        qTotal,
        tTotal,
        target: tParsed.catalog,
        query: qParsed.catalog,
        note:
          (stride > 1 || qSample > 1 || maxOccEff < userCapEntries
            ? `large input: sampling 1/${stride} target k-mers, 1/${qSample} query positions; ` +
              `repeat cutoff ${maxOccEff * stride}× (auto) · `
            : '') + `${parts.length} cores`,
      },
    });
    return;
  }

  const out = {
    x: new F64Vec(1 << 16),
    y: new F64Vec(1 << 16),
    dx: new F32Vec(1 << 16),
    dy: new F32Vec(1 << 16),
    strand: new U8Vec(1 << 16),
    identity: new F32Vec(1 << 16),
  };
  const qTotal = qParsed.catalog.total;
  const tTotal = tParsed.catalog.total;

  const tStarts = tParsed.catalog.starts;
  const qLo = window ? Math.max(0, Math.floor(window.qy0)) : 0;
  const qHi = window ? Math.min(qParsed.codes.length, Math.ceil(window.qy1)) : qParsed.codes.length;
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
  const segments = {
    count: out.x.n,
    x: out.x.done(),
    y: out.y.done(),
    dx: out.dx.done(),
    dy: out.dy.done(),
    strand: out.strand.done(),
    identity: out.identity.done(),
  };
  let identMin = 1;
  for (let i = 0; i < segments.count; i++) {
    if (segments.identity[i] < identMin) identMin = segments.identity[i];
  }
  if (window) {
    post(
      {
        id,
        type: 'regionResult',
        segments,
        window,
        identMin,
        elapsedMs: performance.now() - t0,
      },
      [
        segments.x.buffer,
        segments.y.buffer,
        segments.dx.buffer,
        segments.dy.buffer,
        segments.strand.buffer,
        segments.identity.buffer,
      ],
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
      note:
        stride > 1 || qSample > 1 || maxOccEff < userCapEntries
          ? `large input: sampling 1/${stride} target k-mers, 1/${qSample} query positions; ` +
            `repeat cutoff ${maxOccEff * stride}× (auto)`
          : undefined,
    },
  };
  postResult(id, data);
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
    [
      r.segments.x.buffer,
      r.segments.y.buffer,
      r.segments.dx.buffer,
      r.segments.dy.buffer,
      r.segments.strand.buffer,
      r.segments.identity.buffer,
    ],
  );
}

/** @param {{id:number, buf:ArrayBuffer}} req */
async function handlePaf(req) {
  progress(req.id, 'Reading file', 0);
  const bytes = await maybeGunzip(new Uint8Array(req.buf));
  progress(req.id, 'Parsing alignments', 0.3);
  const data = parsePaf(bytes);
  postResult(req.id, data);
}

/**
 * @param {number} id @param {PlotData} data
 */
function postResult(id, data) {
  const s = data.segments;
  /** @type {Transferable[]} */
  const transfer = [
    s.x.buffer,
    s.y.buffer,
    s.dx.buffer,
    s.dy.buffer,
    s.strand.buffer,
    s.identity.buffer,
    data.target.starts.buffer,
    data.query.starts.buffer,
  ];
  if (data.target.offsets) transfer.push(data.target.offsets.buffer);
  if (data.query.offsets && data.query.offsets !== data.target.offsets) {
    transfer.push(data.query.offsets.buffer);
  }
  post({ id, type: 'result', data }, transfer);
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
