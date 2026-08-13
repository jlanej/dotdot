// @ts-check
/**
 * dotdot main thread: UI wiring, camera interactions, and the render loop.
 * All parsing/matching runs in the compute worker; all data drawing runs in
 * WebGL. This file never touches sequence bytes.
 */
import { View } from './core/transform.js';
import { SegmentGrid } from './core/grid.js';
import { segmentEndpoints, allocSegments, copySegmentRow, blitSegments, segmentVisible } from './core/types.js';
import { assemblePool } from './worker/assemble.js';
import { locate, bandsInRange } from './core/catalog.js';
import { binIdentity, paintHeatmap, heatAt, binStretch } from './render/heatmap.js';
import { resolveRegion, parseBp } from './core/region.js';
import { buildViewHash, parseViewHash } from './core/share.js';
import { GlRenderer } from './render/gl.js';
import { drawUnderlay, drawOverlay, LAYOUT, setAnnotationLanes } from './render/axes.js';
import { buildColormap, hexToRgb } from './render/colormap.js';
import { segmentDistributions, occupancyBins, groupedBarsSVG, ladderLabels } from './render/charts.js';
import { formatBp, formatInt, formatCount } from './render/format.js';
import { looksLikePaf } from './io/paf.js';
import { RemoteTwoBit, regionToFasta } from './io/twobit.js';
import { RemoteBigBed } from './io/bigbed.js';
import { REFERENCES, parseBrowserRegion } from './refs.js';
import { exportPng, compositeCanvases } from './export/png.js';
import { exportSvg } from './export/svg.js';

/** @typedef {import('./core/types.js').PlotData} PlotData */

// --------------------------------------------------------------------------
// DOM

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const plotRoot = $('plot-root');
const underlay = /** @type {HTMLCanvasElement} */ ($('underlay'));
const glcanvas = /** @type {HTMLCanvasElement} */ ($('glcanvas'));
const overlay = /** @type {HTMLCanvasElement} */ ($('overlay'));
const tooltip = $('tooltip');
const emptyState = $('empty-state');
const progressEl = $('progress');
const progressLabel = $('progress-label');
const progressBar = $('progress-bar');
const readout = $('readout');
const toastEl = $('toast');
const hoverCard = $('hover-card');
const legendEl = $('legend');
const statsEl = $('plot-stats-body');
const plotStats = $('plot-stats');

const inK = /** @type {HTMLInputElement} */ ($('in-k'));
const inKNum = /** @type {HTMLInputElement} */ ($('in-k-num'));
const inGap = /** @type {HTMLInputElement} */ ($('in-gap'));
const inMaxOcc = /** @type {HTMLInputElement} */ ($('in-maxocc'));
const inMinRun = /** @type {HTMLInputElement} */ ($('in-minrun'));
const inMinIdent = /** @type {HTMLInputElement} */ ($('in-minident'));
const outMinIdent = $('out-minident');
const inMinLen = /** @type {HTMLInputElement} */ ($('in-minlen'));
const inMinLenRange = /** @type {HTMLInputElement} */ ($('in-minlen-range'));
const outMinLen = $('out-minlen');
const chkAutoRefine = /** @type {HTMLInputElement} */ ($('chk-autorefine'));
const panelDetail = $('panel-detail');
const inSample = /** @type {HTMLInputElement} */ ($('in-sample'));
const chkFwd = /** @type {HTMLInputElement} */ ($('chk-fwd'));
const chkRev = /** @type {HTMLInputElement} */ ($('chk-rev'));
const selColorMode = /** @type {HTMLSelectElement} */ ($('sel-colormode'));
const selDrawMode = /** @type {HTMLSelectElement} */ ($('sel-drawmode'));
const inWidth = /** @type {HTMLInputElement} */ ($('in-width'));
const outWidth = $('out-width');
const chkMinPx = /** @type {HTMLInputElement} */ ($('chk-minpx'));
const chkAspect = /** @type {HTMLInputElement} */ ($('chk-aspect'));
const chkOverlay = /** @type {HTMLInputElement} */ ($('chk-overlay'));
const rowOverlay = $('row-overlay');
const selRef = /** @type {HTMLSelectElement} */ ($('sel-ref'));
const refBox = $('ref-box');
const inRefRegion = /** @type {HTMLInputElement} */ ($('in-refregion'));
const selRefPreset = /** @type {HTMLSelectElement} */ ($('sel-refpreset'));
const rowRefPreset = $('row-refpreset');
const btnCompute = /** @type {HTMLButtonElement} */ ($('btn-compute'));
const btnPng = /** @type {HTMLButtonElement} */ ($('btn-png'));
const btnSvg = /** @type {HTMLButtonElement} */ ($('btn-svg'));
const btnRefine = /** @type {HTMLButtonElement} */ ($('btn-refine'));
const btnShare = /** @type {HTMLButtonElement} */ ($('btn-share'));
const btnZoomRefine = /** @type {HTMLButtonElement} */ ($('btn-zoom-refine'));
const btnStatsDetail = /** @type {HTMLButtonElement} */ ($('btn-stats-detail'));

/** Refine has two homes (Detail panel + the on-plot zoom cluster). */
function setRefineEnabled(/** @type {boolean} */ on) {
  btnRefine.disabled = !on;
  btnZoomRefine.disabled = !on;
}

// ---- min-segment-length: the detail dial -----------------------------------
// One value, three views: log slider (0 = off, 1..100 sweeps 10 bp..100 kb),
// free-text field, and a formatted readout. The 1-2-5 ladder backs [ / ].
const MINLEN_LADDER = [0, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5];

/** @param {number} t slider position 0..100 */
function minLenFromSlider(t) {
  if (t <= 0) return 0;
  const bp = Math.pow(10, 1 + (t / 100) * 4);
  const tick = Math.pow(10, Math.floor(Math.log10(bp))) / 10; // 2 significant figures
  return Math.round(bp / tick) * tick;
}

/** @param {number} bp */
function sliderFromMinLen(bp) {
  if (bp <= 0) return 0;
  return Math.max(1, Math.min(100, Math.round(((Math.log10(bp) - 1) / 4) * 100)));
}

/**
 * Set the display length filter, keeping slider, field, and readout in sync.
 * @param {number} bp @param {{skipText?: boolean}} [o]
 */
function setMinLen(bp, o = {}) {
  if (!o.skipText) inMinLen.value = bp > 0 ? String(Math.round(bp)) : 'off';
  inMinLenRange.value = String(sliderFromMinLen(bp));
  outMinLen.textContent = bp > 0 ? formatBp(bp) : 'off';
  markDirty();
}

// --------------------------------------------------------------------------
// State

const state = {
  /** @type {PlotData | null} */
  data: null,
  /** @type {{segments: import('./core/types.js').SegmentStore, name: string} | null} */
  overlay: null,
  /** @type {SegmentGrid | null} */
  grid: null,
  /** @type {View | null} */
  view: null,
  /** @type {{name: string, bufs: ArrayBuffer[]} | null} */
  fileTarget: null,
  /** @type {{name: string, bufs: ArrayBuffer[]} | null} */
  fileQuery: null,
  computing: false,
  identLo: 0,
  /** @type {number | null} */
  hoverIndex: null,
  /** @type {{x: number, y: number} | null} */
  cursor: null,
  /** @type {{x0:number,y0:number,x1:number,y1:number} | null} */
  selection: null,
  fpsOn: false,
  fps: 0,
  dirty: true,
  sizes: { cssW: 0, cssH: 0, pw: 0, ph: 0 },
};

// Debug/automation handle (read-only usage; also used by the smoke drive).
Object.defineProperty(globalThis, '__dotdot', { value: state });

// --------------------------------------------------------------------------
// Theme

function currentMode() {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  /** @param {string} name */
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    page: v('--page'),
    surface: v('--surface'),
    ink: v('--ink'),
    inkSecondary: v('--ink-2'),
    muted: v('--muted'),
    grid: v('--grid'),
    baseline: v('--baseline'),
    accent: v('--accent'),
  };
}

let theme = readTheme();
/** @type {'light'|'dark'} */
let mode = currentMode();

// --------------------------------------------------------------------------
// Renderer

/** @type {GlRenderer} */
let renderer;
try {
  renderer = new GlRenderer(glcanvas);
  renderer.setTheme(mode);
  renderer.onRestored = () => markDirty();
} catch (err) {
  fatal(err instanceof Error ? err.message : String(err));
  throw err;
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  mode = currentMode();
  theme = readTheme();
  renderer.setTheme(mode);
  updateLegend();
  markDirty();
});

// --------------------------------------------------------------------------
// Worker

/** @type {Worker} */
let worker;
let reqId = 0;
/** @type {number} */
let activeReq = -1;

let dataGen = 0; // bumped whenever the target/query file slots change
let workerGen = -1; // the generation the compute worker has parsed & cached
/** @type {{opts: object, window: {tx0:number,tx1:number,qy0:number,qy1:number} | null} | null} */
let lastKmer = null;

function spawnWorker() {
  workerGen = -1;
  worker = new Worker(new URL('./worker/compute.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.id !== activeReq) return;
    if (msg.type === 'progress') {
      progressLabel.textContent = msg.phase;
      progressBar.style.width = `${Math.round(msg.frac * 100)}%`;
    } else if (msg.type === 'plan') {
      runPool(msg.plan);
    } else if (msg.type === 'result') {
      setComputing(false);
      onData(msg.data, msg.id);
    } else if (msg.type === 'overlayResult') {
      setComputing(false);
      onOverlay(msg);
    } else if (msg.type === 'regionResult') {
      setComputing(false);
      onRegionRefined(msg);
    } else if (msg.type === 'needData') {
      // The worker's parse cache missed (e.g. fresh spawn) — resend with
      // full buffers, carrying any bound post-load actions forward.
      workerGen = -1;
      if (boundActions && boundActions.req === msg.id) {
        queuedActions = { overlay: boundActions.overlay, region: boundActions.region };
        boundActions = null;
      }
      if (lastKmer) submitKmer(lastKmer.opts, lastKmer.window);
      else setComputing(false);
    } else if (msg.type === 'error') {
      setComputing(false);
      toast(msg.message, true);
    }
  };
  worker.onerror = (e) => {
    setComputing(false);
    toast(`Worker failed: ${e.message ?? 'unknown error'}`, true);
  };
}
spawnWorker();

let submitAt = 0;

/**
 * A new submit supersedes whatever ran before it: terminate the busy
 * compute worker and stop any matcher pool, so superseded jobs never grind
 * on in the background pinning CPU cores and shared memory.
 */
function supersede() {
  if (!state.computing) return;
  worker.terminate();
  spawnWorker();
  stopPool();
  setComputing(false);
}

/**
 * @param {{type: string, window?: object, [key: string]: unknown}} payload
 */
function submit(payload) {
  supersede();
  activeReq = ++reqId;
  submitAt = performance.now();
  setComputing(true);
  // Post-load actions bind to base-plot requests only (never refine).
  if (queuedActions && (payload.type === 'paf' || (payload.type === 'kmer' && !payload.window))) {
    boundActions = { req: activeReq, ...queuedActions };
    queuedActions = null;
  }
  worker.postMessage({ id: activeReq, ...payload });
}

function cancelCompute() {
  supersede();
  activeReq = -1;
  toast('Canceled.');
}

// ---- multi-core matching pool (SharedArrayBuffer path) --------------------

/** @type {Worker[]} */
let poolWorkers = [];

function stopPool() {
  for (const w of poolWorkers) w.terminate();
  poolWorkers = [];
}

/**
 * Fan the planned query chunks out over a pool of matcher workers with work
 * stealing: every worker reads the same shared index/query memory, pulls the
 * next chunk when it finishes one, and returns its own segment arrays.
 * Repeat-dense chunks (centromeres) then spread across cores instead of
 * pinning one straggler.
 * @param {any} plan
 */
function runPool(plan) {
  const parts = /** @type {{qLo:number,qHi:number}[]} */ (plan.parts);
  const nWorkers = Math.min(plan.cores ?? 8, parts.length);
  /** @type {any[]} */
  const results = new Array(parts.length).fill(null);
  /** @type {Map<Worker, {part: number, frac: number}>} */
  const active = new Map();
  let next = 0;
  let completed = 0;
  const req = activeReq;
  progressLabel.textContent = `Matching on ${nWorkers} cores`;
  progressBar.style.width = '0%';

  /** @param {Worker} w */
  const dispatch = (w) => {
    const i = next++;
    active.set(w, { part: i, frac: 0 });
    // The shared bundle is forwarded wholesale — new fields can't be
    // dropped between the coordinator and the matchers.
    w.postMessage({ part: i, qLo: parts[i].qLo, qHi: parts[i].qHi, shared: plan.shared });
  };

  const updateBar = () => {
    let sum = completed;
    for (const a of active.values()) sum += a.frac;
    progressBar.style.width = `${Math.round((sum / parts.length) * 100)}%`;
  };

  poolWorkers = Array.from({ length: nWorkers }, () => {
    const w = new Worker(new URL('./worker/match.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      if (req !== activeReq) return;
      const m = ev.data;
      if (m.type === 'progress') {
        const a = active.get(w);
        if (a) a.frac = m.phase === 0 ? (m.done / m.total) * 0.5 : 0.5 + (m.done / m.total) * 0.5;
        updateBar();
      } else if (m.type === 'done') {
        results[m.part] = m.seg;
        completed++;
        active.delete(w);
        if (next < parts.length) {
          dispatch(w);
        } else {
          w.terminate();
          if (completed === parts.length) finishPool(plan, results, req);
        }
        updateBar();
      } else if (m.type === 'error') {
        stopPool();
        setComputing(false);
        toast(m.message, true);
      }
    };
    w.onerror = (e) => {
      if (req !== activeReq) return;
      stopPool();
      setComputing(false);
      toast(`Matcher worker failed: ${e.message ?? 'unknown error'}`, true);
    };
    dispatch(w);
    return w;
  });
}

/**
 * All parts are in: stitch and merge them (chunk-cut faithful), then route
 * to the base-plot or refine path depending on the plan's window.
 * @param {any} plan
 * @param {any[]} results
 * @param {number} req
 */
function finishPool(plan, results, req) {
  poolWorkers = [];
  /** @type {{segments: import('./core/types.js').SegmentStore, identMin: number}} */
  let assembled;
  try {
    assembled = assemblePool(plan, results);
  } catch (err) {
    setComputing(false);
    toast(err instanceof Error ? err.message : String(err), true);
    return;
  }
  setComputing(false);
  if (plan.window) {
    onRegionRefined({ segments: assembled.segments, window: plan.window, identMin: assembled.identMin });
  } else {
    onData(
      {
        target: plan.target,
        query: plan.query,
        segments: assembled.segments,
        source: 'kmer',
        stats: {
          elapsedMs: performance.now() - submitAt,
          identMin: assembled.identMin,
          note: plan.note,
          kmer: plan.kmerStats,
        },
      },
      req,
    );
  }
}

/** @param {boolean} on */
function setComputing(on) {
  state.computing = on;
  progressEl.hidden = !on;
  if (on) {
    progressBar.style.width = '0%';
    emptyState.hidden = true;
  } else {
    emptyState.hidden = state.data !== null;
  }
  btnCompute.disabled = on || !state.fileTarget;
}

// --------------------------------------------------------------------------
// Options

/**
 * Parse a length-ish field that accepts presets or free text: "off"/"" → 0,
 * otherwise any bp expression ("64", "1kb", "2,500").
 * @param {string} text @param {number} [fallback]
 */
function parseLenOff(text, fallback = 0) {
  const t = text.trim().toLowerCase();
  if (t === '' || t === 'off' || t === '0') return 0;
  const v = parseBp(t);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : fallback;
}

/** Current k, clamped to the engine's 4..26 range; empty/garbage = 15. */
function currentK() {
  const t = inKNum.value.trim();
  if (t === '') return 15; // Number('') is 0 — don't let a cleared box mean k=4
  const v = Math.round(Number(t));
  return Number.isFinite(v) ? Math.min(26, Math.max(4, v)) : 15;
}

/**
 * Sampling field: 'auto' follows input size; 'off'/'1' forces full density;
 * any number is honored exactly.
 * @returns {'auto' | number}
 */
function currentSample() {
  const t = inSample.value.trim().toLowerCase();
  if (t === '' || t === 'auto') return 'auto';
  if (t === 'off') return 1;
  const v = parseBp(t);
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : 'auto';
}

function matchOpts() {
  return {
    k: currentK(),
    maxGap: parseLenOff(inGap.value, 64),
    maxOcc: Math.max(1, parseLenOff(inMaxOcc.value, 200) || 200),
    minRunLen: parseLenOff(inMinRun.value, 0),
    sample: currentSample(),
    stride: 1,
  };
}

function displayOpts() {
  return {
    showFwd: chkFwd.checked,
    showRev: chkRev.checked,
    minIdentity: Number(inMinIdent.value),
    minLenBp: parseLenOff(inMinLen.value, 0),
    colorMode: /** @type {0|1} */ (Number(selColorMode.value)),
    widthPx: Number(inWidth.value),
    minLenPx: chkMinPx.checked ? 2.2 : 0,
    identLo: state.identLo,
  };
}

// --------------------------------------------------------------------------
// Data pipeline

/**
 * @param {PlotData} data
 * @param {number} [reqId] the request this result answers — post-load
 *   actions (overlay, region jump) apply only when they were bound to it
 */
function onData(data, reqId = -1) {
  const act = boundActions && boundActions.req === reqId ? boundActions : null;
  if (act) boundActions = null;
  state.data = data;
  state.grid = null;
  state.hoverIndex = null;
  // New base axes invalidate any overlay (its chip too, unless this IS a
  // standalone aligner plot).
  state.overlay = null;
  renderer.setOverlay(null);
  rowOverlay.hidden = true;
  if (data.source === 'kmer') setChip('chip-paf', null);
  renderer.setData(data.segments);
  glcanvas.hidden = false;
  emptyState.hidden = true;

  const identMin = data.stats.identMin;
  state.identLo = identMin >= 0.999 ? 0.9 : Math.max(0, Math.floor(identMin * 100) / 100);
  inMinIdent.min = String(state.identLo);
  inMinIdent.value = String(state.identLo);
  outMinIdent.textContent = 'off';

  state.view = new View(data.target.total, data.query.total);
  fitView();

  updateLegend();
  updateStats();
  btnPng.disabled = false;
  btnSvg.disabled = false;
  btnShare.disabled = false;
  setRefineEnabled(data.source === 'kmer' && !!state.fileTarget);
  panelDetail.hidden = false;
  setMinLen(parseLenOff(inMinLen.value, 0), { skipText: true });
  autoRefinedSig = '';
  annoLanes = { x: [], y: [] };
  syncAnnoLayout();
  lastAnnoSig = '';
  heatBin = null;
  lastHeatSig = '';
  btnCompute.textContent = data.source === 'kmer' ? 'Recompute' : 'Compute dot plot';

  // Build the picking grid after the first frame so the plot appears
  // immediately; hover activates when it's ready.
  setTimeout(() => {
    if (state.data === data) {
      state.grid = new SegmentGrid(data.segments, data.target.total, data.query.total);
      if (act && act.region) jumpToRegion(act.region);
    }
  }, 30);

  // Dense k-mer results (genome scale) default to a structural view: pick the
  // smallest display length filter that keeps the drawn count sane. The data
  // is all there — the slider reveals it live, no recompute.
  if (data.source === 'kmer' && data.segments.count > 2_000_000 && parseLenOff(inMinLen.value) === 0) {
    const dx = data.segments.dx;
    const n = data.segments.count;
    const options = [100, 500, 2000, 10000, 50000];
    const step = Math.max(1, Math.floor(n / 200_000));
    let sampled = 0;
    const counts = new Array(options.length).fill(0);
    for (let i = 0; i < n; i += step) {
      sampled++;
      for (let j = 0; j < options.length; j++) {
        if (dx[i] >= options[j]) counts[j]++;
      }
    }
    for (let j = 0; j < options.length; j++) {
      if ((counts[j] / sampled) * n <= 500_000) {
        setMinLen(options[j]);
        toast(
          `Dense result: showing matches ≥ ${formatBp(options[j])} of ${formatCount(n)} total — ` +
            'lower “min segment length” to reveal more.',
        );
        break;
      }
    }
  } else if (data.stats.note) {
    toast(data.stats.note);
  }
  if (data.source === 'kmer' && act && act.overlay) {
    overlayName = act.overlay.name;
    setChip('chip-paf', act.overlay);
    submit({ type: 'pafOverlay', buf: act.overlay.buf, target: data.target, query: data.query });
  }
  // A shared link's view state applies to the first plot, after the fit.
  if (pendingView) {
    const v = pendingView;
    pendingView = null;
    setMinLen(parseLenOff(v.len, 0));
    inMinIdent.value = String(v.ident);
    inMinIdent.dispatchEvent(new Event('input', { bubbles: true }));
    chkFwd.checked = v.fwd;
    chkRev.checked = v.rev;
    chkAutoRefine.checked = v.auto;
    if (v.draw === 'heat') selDrawMode.value = 'heat';
    const { pw, ph } = state.sizes;
    state.view.fitRect(v.x0, v.y0, v.x1, v.y1, pw, ph);
    if (v.draw === 'heat') rebuildHeatmap();
    updateLegend();
  }
  markDirty();
}

/**
 * Submit a k-mer compute. The request carries the data generation; when the
 * worker's parse cache already holds this generation the FASTA buffers are
 * not re-sent (Recompute and Refine become options-only messages).
 * @param {object} opts
 * @param {{tx0:number,tx1:number,qy0:number,qy1:number} | null} [window]
 */
function submitKmer(opts, window = null) {
  if (!state.fileTarget) {
    toast('Load a target FASTA first.');
    return;
  }
  lastKmer = { opts, window };
  const sendData = workerGen !== dataGen;
  submit({
    type: 'kmer',
    gen: dataGen,
    opts,
    window: window ?? undefined,
    target: sendData ? state.fileTarget.bufs : null,
    query: sendData ? (state.fileQuery ? state.fileQuery.bufs : null) : null,
  });
  workerGen = dataGen;
}

function computeKmer() {
  submitKmer(matchOpts());
}

/** @param {ArrayBuffer} buf */
function computePaf(buf) {
  submit({ type: 'paf', buf });
}

/**
 * A PAF landing on an existing plot becomes the aligner-audit overlay; on an
 * empty app it loads standalone. (PAFs are always single files — the first
 * buffer is the file.)
 * @param {SlotFile} f
 */
function loadPafFile(f) {
  const buf = f.buf ?? f.bufs?.[0];
  if (!buf) return;
  setChip('chip-paf', f);
  if (state.data) {
    overlayName = f.name;
    submit({ type: 'pafOverlay', buf, target: state.data.target, query: state.data.query });
  } else {
    shareBase = null; // a locally picked PAF can't travel in a link
    computePaf(buf);
  }
}

/** @type {string} */
let overlayName = '';
/**
 * Post-load intents (audit overlay to attach, region to frame) travel with
 * the request they belong to instead of ambient globals: load flows queue
 * them, submit() binds them to its request id, and only that exact result
 * consumes them — a superseded or failed load can never leak its overlay
 * onto an unrelated plot.
 * @type {{overlay?: {name: string, buf: ArrayBuffer}, region?: string} | null}
 */
let queuedActions = null;
/** @type {{req: number, overlay?: {name: string, buf: ArrayBuffer}, region?: string} | null} */
let boundActions = null;

/** Reference/demo fetch generation: bumping it invalidates pending installs. */
let refLoadGen = 0;

/**
 * Provenance for shareable links: the query string that reproduces the
 * current DATA (ref=…, demo=1, target=…), or null when it came from local
 * files no link can carry.
 * @type {string | null}
 */
let shareBase = null;
/** View state from the URL hash, applied to the first plot. */
let pendingView = parseViewHash(location.hash);

/** The user pivoted to new data — stale intents must not fire. */
function newLoadIntent() {
  refLoadGen++;
  queuedActions = null;
  shareBase = null;
}

/** @param {{segments: import('./core/types.js').SegmentStore, skipped: number, unknown: number}} msg */
function onOverlay(msg) {
  state.overlay = { segments: msg.segments, name: overlayName };
  renderer.setOverlay(msg.segments);
  rowOverlay.hidden = false;
  chkOverlay.checked = true;
  const parts = [`Aligner overlay: ${formatCount(msg.segments.count)} calls drawn over the plot.`];
  if (msg.unknown > 0) parts.push(`${formatInt(msg.unknown)} lines named sequences not on these axes (dropped).`);
  if (msg.skipped > 0) parts.push(`${formatInt(msg.skipped)} malformed lines skipped.`);
  toast(parts.join(' '));
  updateLegend();
  markDirty();
}

function clearOverlay() {
  state.overlay = null;
  renderer.setOverlay(null);
  rowOverlay.hidden = true;
  setChip('chip-paf', null);
  updateLegend();
}

// --------------------------------------------------------------------------
// Built-in references (remote 2bit, byte-range fetched)

/** @type {Map<string, RemoteTwoBit>} */
const twobits = new Map();

/** @param {import('./refs.js').ReferenceGenome} ref */
function getTwoBit(ref) {
  let tb = twobits.get(ref.id);
  if (!tb) {
    tb = new RemoteTwoBit(ref.twobit);
    twobits.set(ref.id, tb);
  }
  return tb;
}

function currentRef() {
  return REFERENCES.find((r) => r.id === selRef.value) ?? null;
}

for (const r of REFERENCES) {
  const opt = document.createElement('option');
  opt.value = r.id;
  opt.textContent = r.label;
  selRef.append(opt);
}

/**
 * Reflect a reference selection in the UI (region default + presets).
 * @param {boolean} autoload load the default region immediately
 */
function applyRefSelection(autoload) {
  const ref = currentRef();
  refBox.hidden = !ref;
  renderAnnoTracks();
  lastAnnoSig = '';
  if (!ref) return;
  inRefRegion.value = ref.defaultRegion;
  selRefPreset.innerHTML = '';
  rowRefPreset.hidden = ref.presets.length === 0;
  for (const p of ref.presets) {
    const opt = document.createElement('option');
    opt.value = p.region;
    opt.textContent = p.label;
    selRefPreset.append(opt);
  }
  if (autoload) void loadRefRegion(ref.defaultRegion);
}

/**
 * Fetch a reference region (browser coordinates, 1-based) and install it as
 * the target: self-plot when no query FASTA is loaded, query-vs-reference
 * otherwise. The synthesized FASTA carries an `@offset=` token so every
 * coordinate the app shows for it is a true genomic coordinate.
 * @param {string} text
 */
async function loadRefRegion(text) {
  const ref = currentRef();
  if (!ref) return;
  const parsed = parseBrowserRegion(text);
  if (!parsed) {
    toast(`Could not parse region “${text}” — try chrX:57.8M-60.7M (1-based).`, true);
    return;
  }
  // Anything the user does after this (own FASTA, another selection, Clear)
  // bumps the generation; a slow fetch must then discard itself instead of
  // clobbering the newer data.
  const gen = ++refLoadGen;
  try {
    const tb = getTwoBit(ref);
    const meta = await tb.seqMeta(parsed.chrom).catch(async (err) => {
      const names = await tb.names().catch(() => []);
      throw new Error(
        (err instanceof Error ? err.message : String(err)) +
          (names.length ? ` Available: ${names.slice(0, 8).join(', ')}…` : ''),
      );
    });
    if (gen !== refLoadGen) return;
    const start0 = parsed.start1 !== null ? parsed.start1 - 1 : 0;
    const end0 = Math.min(parsed.end1 ?? meta.dnaSize, meta.dnaSize);
    const len = end0 - start0;
    if (len <= 0) {
      toast(`${parsed.chrom} is only ${formatBp(meta.dnaSize)} long.`, true);
      return;
    }
    if (len > 300e6) {
      toast('Region too large — 300 Mb max.', true);
      return;
    }
    const label1 = `${parsed.chrom}:${formatInt(start0 + 1)}-${formatInt(end0)}`;
    toast(
      `Fetching ${label1} (${formatBp(len)}) from ${ref.label}…` +
        (len > 33e6 ? ' Large region — this will take a while.' : ''),
    );
    const buf = await streamRefRegions(ref, [{ chrom: parsed.chrom, start0, end0 }]);
    if (gen !== refLoadGen) return;
    setFasta('target', { name: `${label1} · ${ref.label}`, buf: buf.buffer });
    shareBase = new URLSearchParams({ ref: ref.id, refregion: text }).toString();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * Stream reference windows (0-based half-open) and wrap them as one FASTA.
 * Record labels and @offset tokens derive from the same numbers, so the
 * displayed coordinates can never drift from what was fetched.
 * @param {import('./refs.js').ReferenceGenome} ref
 * @param {{chrom: string, start0: number, end0: number, name?: string}[]} regions
 */
async function streamRefRegions(ref, regions) {
  const tb = getTwoBit(ref);
  const parts = await Promise.all(regions.map((r) => tb.fetchRegion(r.chrom, r.start0, r.end0)));
  const fastas = regions.map((r, i) => {
    const label = `${r.chrom}:${formatInt(r.start0 + 1)}-${formatInt(r.end0)}`;
    return regionToFasta(r.name ?? r.chrom, `${ref.label} ${label}`, r.start0, parts[i]);
  });
  let total = 0;
  for (const f of fastas) total += f.length;
  const out = new Uint8Array(total);
  let w = 0;
  for (const f of fastas) {
    out.set(f, w);
    w += f.length;
  }
  return out;
}

selRef.addEventListener('change', () => applyRefSelection(true));
selRefPreset.addEventListener('change', () => {
  inRefRegion.value = selRefPreset.value;
  void loadRefRegion(selRefPreset.value);
});
$('btn-refload').addEventListener('click', () => void loadRefRegion(inRefRegion.value));
inRefRegion.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void loadRefRegion(inRefRegion.value);
});

// --------------------------------------------------------------------------
// Annotation tracks: remote bigBeds (CenSat, genes, segdups) drawn as lanes
// in the axis margins for any sequence that resolves to a reference
// chromosome — record names match directly ('chr8') or as a slice prefix
// ('chr17_ROI10.9' → chr17), with @offset display coordinates mapping lane
// items into the right place. Fetches are viewport-driven (on view settle),
// tile-cached, and cost only ranged reads of the remote index.

/** @type {Map<string, RemoteBigBed>} */
const bigbeds = new Map();
/** @param {string} url */
function getBigBed(url) {
  let bb = bigbeds.get(url);
  if (!bb) {
    bb = new RemoteBigBed(url);
    bigbeds.set(url, bb);
  }
  return bb;
}

/** The genome annotations resolve against (the selected reference, else T2T). */
function annoGenome() {
  return currentRef() ?? REFERENCES[0];
}

/** @type {Map<string, boolean>} trackId -> enabled */
const annoEnabled = new Map();
/** @type {Map<string, import('./io/bigbed.js').BedItem[]>} `${url}|${chrom}|${tile}` -> items */
const annoTiles = new Map();
const ANNO_TILE = 1_000_000;
/** @type {{x: import('./render/axes.js').AnnoLane[], y: import('./render/axes.js').AnnoLane[]}} */
let annoLanes = { x: [], y: [] };
let lastAnnoSig = '';
let annoBusy = false;
let annoLaneCounts = { x: 0, y: 0 };

function activeTracks() {
  return annoGenome().tracks.filter((t) => annoEnabled.get(t.id) ?? t.on);
}

/**
 * Resolve an axis record name to a chromosome of the annotation genome.
 * @param {string} name @param {Map<string, {id:number, size:number}>} chroms
 */
function resolveChrom(name, chroms) {
  if (chroms.has(name)) return name;
  const prefix = name.split('_', 1)[0];
  return chroms.has(prefix) ? prefix : null;
}

/**
 * Query one track with 1 Mb tile caching (items spanning tiles dedupe).
 * @param {import('./refs.js').RefTrack} track
 * @param {string} chrom @param {number} s @param {number} e
 */
async function tileQuery(track, chrom, s, e) {
  const bb = getBigBed(track.url);
  const t0 = Math.max(0, Math.floor(s / ANNO_TILE));
  const t1 = Math.max(t0, Math.floor(Math.max(s, e - 1) / ANNO_TILE));
  /** @type {import('./io/bigbed.js').BedItem[]} */
  const out = [];
  const seen = new Set();
  for (let t = t0; t <= t1; t++) {
    const key = `${track.url}|${chrom}|${t}`;
    let arr = annoTiles.get(key);
    if (!arr) {
      arr = await bb.query(chrom, t * ANNO_TILE, (t + 1) * ANNO_TILE);
      annoTiles.set(key, arr);
      if (annoTiles.size > 400) {
        const oldest = annoTiles.keys().next().value;
        if (oldest !== undefined) annoTiles.delete(oldest);
      }
    }
    for (const it of arr) {
      if (it.end <= s || it.start >= e) continue;
      const k = `${it.start}:${it.end}:${it.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

/**
 * Build world-coordinate lanes for one axis, or null when no visible record
 * resolves to a chromosome of the annotation genome.
 * @param {import('./core/types.js').AxisCatalog} cat
 * @param {number} w0 @param {number} w1
 * @param {import('./refs.js').RefTrack[]} tracks
 */
async function buildAxisLanes(cat, w0, w1, tracks) {
  /** @type {import('./render/axes.js').AnnoLane[]} */
  const lanes = tracks.map((t) => ({ label: t.label, colored: !!t.colored, items: [] }));
  const { first, last } = bandsInRange(cat, w0, w1);
  if (last < first) return null;
  let resolvedAny = false;
  for (let i = first; i <= last; i++) {
    for (let k = 0; k < tracks.length; k++) {
      const chroms = await getBigBed(tracks[k].url).chroms();
      const chrom = resolveChrom(cat.names[i], chroms);
      if (!chrom) continue;
      resolvedAny = true;
      const off = cat.offsets ? cat.offsets[i] : 0;
      const bandStart = cat.starts[i];
      const bandEnd = cat.starts[i + 1];
      const visS = Math.max(w0, bandStart) - bandStart + off;
      const visE = Math.min(w1, bandEnd) - bandStart + off;
      if (visE <= visS) continue;
      const items = await tileQuery(tracks[k], chrom, Math.floor(visS), Math.ceil(visE));
      for (const it of items) {
        lanes[k].items.push({
          w0: Math.max(bandStart, bandStart + (it.start - off)),
          w1: Math.min(bandEnd, bandStart + (it.end - off)),
          rgb: it.rgb,
          name: it.name,
          strand: it.strand,
        });
      }
    }
  }
  return resolvedAny ? lanes : null;
}

/** Apply lane reservations to the margins; relayout when counts change. */
function syncAnnoLayout() {
  const nx = annoLanes.x.length;
  const ny = annoLanes.y.length;
  if (nx !== annoLaneCounts.x || ny !== annoLaneCounts.y) {
    annoLaneCounts = { x: nx, y: ny };
    setAnnotationLanes(nx, ny);
    resize();
  }
}

async function refreshAnnotations() {
  const d = state.data;
  if (!d || !state.view) return;
  const tracks = activeTracks();
  if (tracks.length === 0) {
    annoLanes = { x: [], y: [] };
    syncAnnoLayout();
    markDirty();
    return;
  }
  const { pw, ph } = state.sizes;
  const b = state.view.bounds(pw, ph);
  annoBusy = true;
  try {
    const [lx, ly] = await Promise.all([
      buildAxisLanes(d.target, Math.max(0, b.x0), Math.min(d.target.total, b.x1), tracks),
      buildAxisLanes(d.query, Math.max(0, b.y0), Math.min(d.query.total, b.y1), tracks),
    ]);
    if (state.data === d) {
      annoLanes = { x: lx ?? [], y: ly ?? [] };
      syncAnnoLayout();
      markDirty();
    }
  } catch (err) {
    console.warn('annotations:', err);
  }
  annoBusy = false;
}

// --------------------------------------------------------------------------
// Identity-heatmap draw mode: visible segments bin into world-anchored tiles
// colored by best identity (StainedGlass-style). Rebinned when the view
// settles; between rebins the anchored image pans/zooms like a map tile.

/** @type {import('./render/heatmap.js').HeatBin | null} */
let heatBin = null;
/** @type {HTMLCanvasElement | null} */
let heatCanvas = null;
let lastHeatSig = '';
/** @type {{lo: number, hi: number}} the ramp's stretched identity range */
let heatRange = { lo: 0, hi: 1 };
let heatKickPending = false;

function heatMode() {
  return selDrawMode.value === 'heat';
}

function rebuildHeatmap() {
  const d = state.data;
  if (!d || !state.view || !heatMode()) return;
  const { pw, ph } = state.sizes;
  const vb = state.view.bounds(pw, ph);
  const b = {
    x0: Math.max(0, vb.x0),
    x1: Math.min(d.target.total, vb.x1),
    y0: Math.max(0, vb.y0),
    y1: Math.min(d.query.total, vb.y1),
  };
  if (b.x1 <= b.x0 || b.y1 <= b.y0) return;
  const nx = Math.min(1024, Math.max(64, Math.round(pw / 1.5)));
  const ny = Math.min(1024, Math.max(64, Math.round(ph / 1.5)));
  const bin = binIdentity(d.segments, b, nx, ny, { showFwd: chkFwd.checked, showRev: chkRev.checked });
  heatRange = binStretch(bin);
  const cm = buildColormap(mode);
  const img = paintHeatmap(bin, cm.data, 0, heatRange.lo, heatRange.hi);
  if (!heatCanvas) heatCanvas = document.createElement('canvas');
  heatCanvas.width = nx;
  heatCanvas.height = ny;
  /** @type {CanvasRenderingContext2D} */ (heatCanvas.getContext('2d')).putImageData(img, 0, 0);
  heatBin = bin;
  updateLegend();
  markDirty();
}

/** Settle watcher for heatmap rebins. @param {number} now */
function heatmapTick(now) {
  if (!heatMode() || !state.data) return;
  // Small plots rebin almost immediately; big ones wait for a firmer rest.
  const settleMs = state.data.segments.count < 1_500_000 ? 120 : 250;
  if (now - viewSettledAt < settleMs || lastViewSig === lastHeatSig || lastViewSig === '') return;
  lastHeatSig = lastViewSig;
  rebuildHeatmap();
}

selDrawMode.addEventListener('change', () => {
  if (heatMode()) {
    rebuildHeatmap();
  } else {
    heatBin = null;
  }
  setHover(null, null);
  updateLegend();
  markDirty();
});

/** Settle watcher for annotation fetches (rides the frame loop). @param {number} now */
function annotationTick(now) {
  if (!state.data || annoBusy) return;
  if (activeTracks().length === 0) {
    if (annoLanes.x.length || annoLanes.y.length) {
      annoLanes = { x: [], y: [] };
      syncAnnoLayout();
      markDirty();
    }
    return;
  }
  if (now - viewSettledAt < 400 || lastViewSig === lastAnnoSig || lastViewSig === '') return;
  lastAnnoSig = lastViewSig;
  void refreshAnnotations();
}

/** Populate the sidebar track checkboxes for the current annotation genome. */
function renderAnnoTracks() {
  const box = $('anno-tracks');
  const ref = annoGenome();
  if (ref.tracks.length === 0) {
    box.innerHTML = '<p class="hint" style="margin:0">no tracks for this reference yet</p>';
    return;
  }
  box.innerHTML = '';
  for (const t of ref.tracks) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = annoEnabled.get(t.id) ?? t.on;
    cb.addEventListener('change', () => {
      annoEnabled.set(t.id, cb.checked);
      lastAnnoSig = '';
    });
    label.append(cb, document.createTextNode(t.label));
    box.append(label);
  }
}

/**
 * Default demo: two slices of real chr17 vs both NA19240 haplotypes,
 * alignment-free with minimap2's calls as the audit overlay. The target is
 * streamed live from the T2T reference (first-class support in action);
 * offline or if UCSC is unreachable, the committed copy steps in.
 */
async function loadDemo() {
  const gen = ++refLoadGen;
  const carriedRegion = queuedActions?.region;
  queuedActions = null;
  try {
    const [q, o] = await Promise.all([
      fetchAsFile('testdata/demo/query.fa.gz'),
      fetchAsFile('testdata/demo/minimap2_demo.paf'),
    ]);
    if (gen !== refLoadGen) return;
    /** @type {{name: string, buf: ArrayBuffer}} */
    let t;
    let source;
    try {
      // Must match scripts/make_demo.sh LOCI so the streamed target stays
      // byte-identical to the committed fallback.
      const buf = await streamRefRegions(REFERENCES[0], [
        { chrom: 'chr17', start0: 18_000_000, end0: 19_600_000, name: 'chr17_17p11.2' },
        { chrom: 'chr17', start0: 10_600_000, end0: 11_200_000, name: 'chr17_ROI10.9' },
      ]);
      t = { name: 'chr17 slices · T2T (streamed)', buf: buf.buffer };
      source = 'streamed live from the T2T reference';
    } catch {
      t = await fetchAsFile('testdata/demo/target.fa.gz');
      source = 'from the committed offline copy';
    }
    if (gen !== refLoadGen) return;
    // Open on structure (17p11.2 is segdup-dense); the length slider
    // reveals the full repeat fabric live.
    setMinLen(500);
    // Both slots land in the same tick so the debounced autocompute runs
    // exactly once, on the demo pair — and the overlay binds to that request.
    queuedActions = { overlay: o, region: carriedRegion };
    setFasta('query', q);
    setFasta('target', t);
    shareBase = 'demo=1';
    toast(
      `Real chr17 loci vs both NA19240 haplotypes, alignment-free — target ${source}. ` +
        '17p11.2: heterozygous 250 kb inversion (hap1) + inverted duplication (hap2). ROI10.9: ' +
        'heterozygous ~5 kb deletion — press G, jump chr17_ROI10.9:10.88M-10.92M. ' +
        'minimap2’s calls overlay in ink.',
    );
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * Full chr17 × NA19240: alignment-free when the fetched FASTAs are present
 * (scripts/fetch_realdata.sh), otherwise the committed aligner PAF with a
 * pointer to the script.
 */
async function loadFullChr17() {
  const gen = ++refLoadGen;
  const carriedRegion = queuedActions?.region;
  queuedActions = null;
  const T = 'testdata/real/chr17.fa';
  const Q = 'testdata/real/NA19240_chr17.fa';
  try {
    const [tHead, qHead] = await Promise.all([
      fetch(T, { method: 'HEAD' }).catch(() => null),
      fetch(Q, { method: 'HEAD' }).catch(() => null),
    ]);
    if (gen !== refLoadGen) return;
    if (tHead?.ok && qHead?.ok) {
      inK.value = '16';
      inKNum.value = '16';
      const o = await fetchAsFile('testdata/real/NA19240_vs_chm13_chr17.paf');
      toast(
        'Computing the full 84 Mb × 170 Mb chr17 comparison alignment-free — this takes minutes ' +
          '(Cancel anytime). minimap2’s calls will overlay when it finishes.',
      );
      const t = await fetchAsFile(T);
      const q = await fetchAsFile(Q);
      if (gen !== refLoadGen) return;
      queuedActions = { overlay: o, region: carriedRegion };
      setFasta('query', q);
      setFasta('target', t);
    } else {
      const f = await fetchAsFile('testdata/real/NA19240_vs_chm13_chr17.paf');
      if (gen !== refLoadGen) return;
      queuedActions = { region: carriedRegion ?? 'chr17:18.3M-19.4M' };
      setChip('chip-paf', f);
      computePaf(f.buf);
      shareBase = new URLSearchParams({ paf: 'testdata/real/NA19240_vs_chm13_chr17.paf' }).toString();
      toast(
        'Full-chromosome FASTAs are not present (run scripts/fetch_realdata.sh to get them) — ' +
          'showing the aligner’s PAF view instead.',
      );
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

// --------------------------------------------------------------------------
// Files

/**
 * @param {File} file
 * @returns {Promise<{name: string, buf: ArrayBuffer}>}
 */
async function readFile(file) {
  return { name: file.name, buf: await file.arrayBuffer() };
}

/** @param {{name: string, buf: ArrayBuffer}} f */
function isPafFile(f) {
  const n = f.name.toLowerCase();
  if (n.endsWith('.paf') || n.endsWith('.paf.gz')) return true;
  if (n.endsWith('.fa') || n.endsWith('.fasta') || n.endsWith('.fna') || n.endsWith('.gz')) {
    return false;
  }
  return looksLikePaf(new Uint8Array(f.buf, 0, Math.min(f.buf.byteLength, 65536)));
}

/**
 * A slot entry: one file ({buf}) or several stacked files ({bufs}).
 * @typedef {{name: string, buf?: ArrayBuffer, bufs?: ArrayBuffer[]}} SlotFile
 */

/**
 * @param {'target'|'query'} slot
 * @param {SlotFile} f
 */
function setFasta(slot, f) {
  dataGen++; // the worker's parse cache is stale from here on
  const entry = { name: f.name, bufs: f.bufs ?? [/** @type {ArrayBuffer} */ (f.buf)] };
  if (slot === 'target') {
    state.fileTarget = entry;
    setChip('chip-target', entry);
  } else {
    state.fileQuery = entry;
    setChip('chip-query', entry);
  }
  btnCompute.disabled = !state.fileTarget || state.computing;
  btnCompute.textContent = 'Compute dot plot';
  scheduleAutoCompute();
}

/** @param {SlotFile} f */
function slotBytes(f) {
  if (f.bufs) {
    let n = 0;
    for (const b of f.bufs) n += b.byteLength;
    return n;
  }
  return f.buf ? f.buf.byteLength : 0;
}

/** @param {string} id @param {SlotFile | null} f */
function setChip(id, f) {
  const el = $(id);
  if (f) {
    el.textContent = `${f.name} · ${formatBytes(slotBytes(f))}`;
    el.classList.add('loaded');
    el.title = f.name;
  } else {
    el.textContent = id === 'chip-query' ? '= target' : '—';
    el.classList.remove('loaded');
    el.title = '';
  }
}

/** @param {number} b */
function formatBytes(b) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} kB`;
  return `${b} B`;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let autoTimer;
function scheduleAutoCompute() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (state.fileTarget && !state.computing) computeKmer();
  }, 150);
}

/** @param {File[]} files */
async function handleFiles(files) {
  const loaded = await Promise.all(files.map(readFile));
  /** @type {{name: string, buf: ArrayBuffer}[]} */
  const pafs = [];
  /** @type {{name: string, buf: ArrayBuffer}[]} */
  const fastas = [];
  for (const f of loaded) (isPafFile(f) ? pafs : fastas).push(f);
  newLoadIntent();
  if (fastas.length > 0 && pafs.length > 0) {
    // FASTAs and a PAF in one drop: the PAF is the audit overlay for the
    // plot those FASTAs are about to produce, not a standalone plot.
    queuedActions = { overlay: pafs[0] };
    if (pafs.length > 1) toast('Multiple PAFs in one drop — using the first as the overlay.');
  } else {
    for (const p of pafs) loadPafFile(p);
  }
  if (fastas.length >= 3) {
    // Many FASTAs at once: the common gesture is one reference plus several
    // assemblies — first file rules the x axis, the rest stack on the y.
    setFasta('target', fastas[0]);
    setFasta('query', {
      name: `${fastas.length - 1} files`,
      bufs: fastas.slice(1).map((f) => /** @type {ArrayBuffer} */ (f.buf)),
    });
    toast(
      `${fastas.length} FASTAs — “${fastas[0].name}” is the target; the other ` +
        `${fastas.length - 1} stack on the query axis.`,
    );
  } else {
    for (const f of fastas) {
      if (!state.fileTarget) setFasta('target', f);
      else if (!state.fileQuery) setFasta('query', f);
      else {
        setFasta('target', f);
        state.fileQuery = null;
        setChip('chip-query', null);
      }
    }
  }
}

/** @param {string} id @param {(f: SlotFile) => void} fn */
function wireFileInput(id, fn) {
  const input = /** @type {HTMLInputElement} */ ($(id));
  input.addEventListener('change', async () => {
    const files = Array.from(input.files ?? []);
    try {
      if (files.length === 1) {
        fn(await readFile(files[0]));
      } else if (files.length > 1) {
        // Multi-select stacks every chosen file onto this axis.
        const loaded = await Promise.all(files.map(readFile));
        fn({ name: `${files.length} files`, bufs: loaded.map((l) => l.buf) });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    }
    input.value = '';
  });
}

wireFileInput('file-target', (f) => {
  newLoadIntent();
  setFasta('target', f);
});
wireFileInput('file-query', (f) => {
  newLoadIntent();
  setFasta('query', f);
});
wireFileInput('file-paf', loadPafFile);

plotRoot.addEventListener('dragover', (e) => {
  e.preventDefault();
  plotRoot.classList.add('dragover');
});
plotRoot.addEventListener('dragleave', () => plotRoot.classList.remove('dragover'));
plotRoot.addEventListener('drop', (e) => {
  e.preventDefault();
  plotRoot.classList.remove('dragover');
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length > 0) {
    handleFiles(files).catch((err) => toast(err instanceof Error ? err.message : String(err), true));
  }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
// Final backstop against text-selection drags stealing plot gestures in
// WebKit browsers.
plotRoot.addEventListener('selectstart', (e) => e.preventDefault());

// --------------------------------------------------------------------------
// View / drawing

function fitView() {
  if (!state.view) return;
  const { pw, ph } = state.sizes;
  state.view.fit(pw, ph, chkAspect.checked);
  markDirty();
}

/** Cycle state: repeating the same jump steps through the mapping clusters. */
let lastJump = { expr: '', idx: -1 };

/**
 * Zoom to a target-axis region expression; the query-axis range is derived
 * from the segments that actually map there (ignoring sub-1% noise unless
 * nothing else matches).
 * @param {string} expr
 */
function jumpToRegion(expr) {
  if (!state.data || !state.view) {
    toast('Load data before jumping to a region.');
    return;
  }
  const r = resolveRegion(expr, state.data.target);
  if (!r) {
    toast(`Could not parse region “${expr}” — try chr17:45M-46.5M or a sequence name.`, true);
    return;
  }
  const { pw, ph } = state.sizes;
  const span = r.x1 - r.x0;
  let y0 = Infinity;
  let y1 = -Infinity;
  let otherClusters = 0;
  const grid = state.grid;
  if (grid) {
    const s = state.data.segments;
    const qTotal = state.data.query.total;
    /**
     * Gather query-side intervals of segments overlapping the x-range.
     * @param {number} threshold
     * @returns {{a: number, b: number, w: number}[]}
     */
    const collect = (threshold) => {
      /** @type {{a: number, b: number, w: number}[]} */
      const iv = [];
      grid.query(r.x0, 0, r.x1, qTotal, (i) => {
        if (s.dx[i] < threshold) return;
        if (s.x[i] + s.dx[i] < r.x0 || s.x[i] > r.x1) return;
        // Clip the query-side interval to the x-overlap (linear along the
        // alignment, strand-aware) so edge-crossing alignments don't bloat
        // the view.
        const t0 = Math.min(1, Math.max(0, (r.x0 - s.x[i]) / s.dx[i]));
        const t1 = Math.min(1, Math.max(0, (r.x1 - s.x[i]) / s.dx[i]));
        const rev = s.strand[i] === 1;
        const qa = s.y[i] + (rev ? (1 - t0) : t0) * s.dy[i];
        const qb = s.y[i] + (rev ? (1 - t1) : t1) * s.dy[i];
        iv.push({ a: Math.min(qa, qb), b: Math.max(qa, qb), w: (t1 - t0) * s.dx[i] });
      });
      return iv;
    };
    let iv = collect(span * 0.01);
    if (iv.length === 0) iv = collect(0);
    if (iv.length > 0) {
      // Distant mapping locations (e.g. the two haplotype bands) cannot share
      // one compact viewport — cluster the intervals and frame the heaviest.
      iv.sort((p, q) => p.a - q.a);
      const gapLimit = Math.max(3 * span, Math.min(2e6, qTotal * 0.05));
      /** @type {{a: number, b: number, w: number}[]} */
      const clusters = [];
      for (const seg of iv) {
        const last = clusters[clusters.length - 1];
        if (last && seg.a - last.b <= gapLimit) {
          last.b = Math.max(last.b, seg.b);
          last.w += seg.w;
        } else {
          clusters.push({ ...seg });
        }
      }
      clusters.sort((p, q) => q.w - p.w);
      let idx = 0;
      if (clusters.length > 1 && lastJump.expr === expr) {
        idx = (lastJump.idx + 1) % clusters.length;
      }
      lastJump = { expr, idx };
      const best = clusters[idx];
      y0 = best.a;
      y1 = best.b;
      otherClusters = clusters.length - 1;
      if (otherClusters > 0) {
        const at = locate(state.data.query, (best.a + best.b) / 2);
        toast(
          `Mapping ${idx + 1} of ${clusters.length} on the query axis` +
            (at ? ` (${at.name})` : '') +
            ' — Go again to cycle through the others.',
        );
      }
    }
  }
  if (!(y1 > y0)) {
    y0 = 0;
    y1 = state.data.query.total;
  }
  const padX = span * 0.04;
  const padY = Math.max((y1 - y0) * 0.04, span * 0.02);
  state.view.fitRect(r.x0 - padX, y0 - padY, r.x1 + padX, y1 + padY, pw, ph);
  markDirty();
}

function markDirty() {
  state.dirty = true;
}

function resize() {
  const r = plotRoot.getBoundingClientRect();
  const cssW = Math.max(80, r.width);
  const cssH = Math.max(80, r.height);
  const pw = Math.max(10, cssW - LAYOUT.l - LAYOUT.r);
  const ph = Math.max(10, cssH - LAYOUT.t - LAYOUT.b);
  const wasDegenerate = state.sizes.pw <= 40 || state.sizes.ph <= 40;
  state.sizes = { cssW, cssH, pw, ph };
  // A fit computed against a degenerate viewport (hidden/background tab at
  // load) is meaningless — refit once real dimensions arrive.
  if (state.view && wasDegenerate && pw > 40 && ph > 40) {
    state.view.fit(pw, ph, chkAspect.checked);
  }
  underlay.style.width = overlay.style.width = `${cssW}px`;
  underlay.style.height = overlay.style.height = `${cssH}px`;
  plotStats.style.left = `${LAYOUT.l + 10}px`;
  glcanvas.style.left = `${LAYOUT.l}px`;
  glcanvas.style.top = `${LAYOUT.t}px`;
  glcanvas.style.width = `${pw}px`;
  glcanvas.style.height = `${ph}px`;
  markDirty();
}

new ResizeObserver(resize).observe(plotRoot);
resize();

let lastFrame = performance.now();
let lastDpr = window.devicePixelRatio || 1;

function frame() {
  const dpr = window.devicePixelRatio || 1;
  if (dpr !== lastDpr) {
    lastDpr = dpr;
    state.dirty = true;
  }
  if (state.dirty) {
    draw(dpr);
    state.dirty = false;
    const now = performance.now();
    const dt = now - lastFrame;
    lastFrame = now;
    if (dt > 0 && dt < 1000) state.fps = state.fps * 0.85 + (1000 / dt) * 0.15;
  }
  autoRefineTick(performance.now());
  annotationTick(performance.now());
  heatmapTick(performance.now());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @param {number} dpr */
function draw(dpr) {
  const { cssW, cssH, pw, ph } = state.sizes;
  const d = displayOpts();

  const heat = heatMode() && heatBin && heatCanvas;
  // Belt and braces for crispness: zoomed far past the current bin's
  // resolution (anchored image stretching >6×), rebin on the next tick even
  // if the settle plumbing missed it.
  if (heat && heatBin && state.view && !heatKickPending) {
    const vb = state.view.bounds(pw, ph);
    const zoomX = (heatBin.x1 - heatBin.x0) / Math.max(vb.x1 - vb.x0, 1e-9);
    const zoomY = (heatBin.y1 - heatBin.y0) / Math.max(vb.y1 - vb.y0, 1e-9);
    if (zoomX > 6 || zoomY > 6) {
      heatKickPending = true;
      setTimeout(() => {
        heatKickPending = false;
        rebuildHeatmap();
      }, 0);
    }
  }
  if (state.view && state.data) {
    /** @type {Float64Array | null} */
    let highlightEp = null;
    if (!heat && state.hoverIndex != null) {
      highlightEp = new Float64Array(4);
      segmentEndpoints(state.data.segments, state.hoverIndex, highlightEp);
    }
    renderer.render({
      view: state.view,
      vpW: pw,
      vpH: ph,
      dpr,
      clear: hexToRgb(theme.surface),
      widthPx: d.widthPx,
      minLenPx: d.minLenPx,
      alpha: 0.85,
      colorMode: d.colorMode,
      identLo: d.identLo,
      // Heatmap mode hides the base segment layer with the strand uniforms
      // (zero GPU churn); the aligner overlay still draws on top.
      showFwd: heat ? false : d.showFwd,
      showRev: heat ? false : d.showRev,
      minIdentity: d.minIdentity,
      minLenBp: d.minLenBp,
      highlight: highlightEp,
      highlightRgb: hexToRgb(cssHexOrFallback(theme.ink)),
      overlayShow: state.overlay !== null && chkOverlay.checked,
      overlayRgb: hexToRgb(cssHexOrFallback(theme.ink)),
    });
  }
  drawUnderlay(
    underlay, cssW, cssH, dpr, state.view, state.data, theme,
    heat && heatBin && heatCanvas ? { canvas: heatCanvas, x0: heatBin.x0, x1: heatBin.x1, y0: heatBin.y0, y1: heatBin.y1 } : null,
  );
  drawOverlay({
    canvas: overlay,
    cssW,
    cssH,
    dpr,
    view: state.view,
    data: state.data,
    theme,
    cursor: state.cursor,
    selection: state.selection,
    fps: state.fpsOn ? state.fps : null,
    annoX: annoLanes.x,
    annoY: annoLanes.y,
  });
}

/** @param {string} c */
function cssHexOrFallback(c) {
  return c.startsWith('#') ? c : '#0b0b0b';
}

// Synchronous render for the debug/automation handle: rAF pauses in hidden
// tabs, which otherwise makes programmatic captures race the redraw.
Object.defineProperty(globalThis, '__dotdotDraw', {
  value: () => {
    draw(window.devicePixelRatio || 1);
    state.dirty = false;
  },
});

// The settle watchers ride the rAF loop — these drive one tick manually so
// hidden-tab automation can exercise auto-refine and annotation fetches
// deterministically.
Object.defineProperty(globalThis, '__dotdotAutoTick', {
  value: (/** @type {number} */ now) => autoRefineTick(now),
});
Object.defineProperty(globalThis, '__dotdotAnnoTick', {
  value: (/** @type {number} */ now) => annotationTick(now),
});

// Full-quality frame capture for automation/screenshots: renders the plot at
// the requested pixel density (independent of the window's devicePixelRatio)
// and returns the composited plot as a PNG data URL.
Object.defineProperty(globalThis, '__dotdotCapture', {
  value: (/** @type {number} */ dpr = 2) => {
    const stashCursor = state.cursor;
    const stashFps = state.fpsOn;
    state.cursor = null;
    state.fpsOn = false;
    draw(dpr);
    const url = compositeCanvases({ underlay, glCanvas: glcanvas, overlay, dpr }).toDataURL('image/png');
    state.cursor = stashCursor;
    state.fpsOn = stashFps;
    draw(window.devicePixelRatio || 1);
    return url;
  },
});

// --------------------------------------------------------------------------
// Pointer interactions

let panning = false;
let selecting = false;
let lastX = 0;
let lastY = 0;
/** @type {MouseEvent | PointerEvent | null} */
let pendingHover = null;

/** @param {PointerEvent} e @returns {{x: number, y: number}} plot-area px */
function plotXY(e) {
  const r = plotRoot.getBoundingClientRect();
  return { x: e.clientX - r.left - LAYOUT.l, y: e.clientY - r.top - LAYOUT.t };
}

overlay.addEventListener('pointerdown', (e) => {
  if (!state.view) return;
  // Claim the gesture before the browser starts a native selection drag.
  e.preventDefault();
  try {
    overlay.setPointerCapture(e.pointerId);
  } catch {
    // Pointer already retired (pen lift, touch cancel, synthetic events) —
    // capture is an optimization, never a requirement.
  }
  const p = plotXY(e);
  if (e.shiftKey) {
    selecting = true;
    state.selection = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  } else {
    panning = true;
    overlay.style.cursor = 'grabbing';
  }
  lastX = e.clientX;
  lastY = e.clientY;
});

overlay.addEventListener('pointermove', (e) => {
  if (!state.view) return;
  const p = plotXY(e);
  state.cursor = p;
  if (panning) {
    state.view.panPx(e.clientX - lastX, e.clientY - lastY);
    state.view.clampPan();
    lastX = e.clientX;
    lastY = e.clientY;
    setHover(null, e);
  } else if (selecting && state.selection) {
    state.selection.x1 = p.x;
    state.selection.y1 = p.y;
  } else {
    pendingHover = e;
    laneHover(p, e);
  }
  updateReadout(p);
  markDirty();
});

let laneTipOn = false;

/**
 * Hover info for annotation-lane items in the margins; no-ops (and cleans
 * up its tooltip) when the cursor is over the plot itself.
 * @param {{x: number, y: number}} p plot-relative px
 * @param {PointerEvent} e
 */
function laneHover(p, e) {
  const { pw, ph } = state.sizes;
  /** @type {import('./render/axes.js').AnnoLane | null} */
  let lane = null;
  let world = 0;
  /** @type {import('./core/types.js').AxisCatalog | null} */
  let cat = null;
  if (state.view && state.data) {
    if (p.y > ph + 6 && p.x >= 0 && p.x <= pw && annoLanes.x.length > 0) {
      const li = Math.floor((p.y - ph - 20) / 16);
      if (li >= 0 && li < annoLanes.x.length) {
        lane = annoLanes.x[li];
        world = state.view.pxToWorldX(p.x, pw);
        cat = state.data.target;
      }
    } else if (p.x < 0 && p.y >= 0 && p.y <= ph && annoLanes.y.length > 0) {
      const cssX = p.x + LAYOUT.l;
      const li = Math.floor((cssX - 28) / 16);
      if (cssX >= 28 && li >= 0 && li < annoLanes.y.length) {
        lane = annoLanes.y[li];
        world = state.view.pxToWorldY(p.y, ph);
        cat = state.data.query;
      }
    }
  }
  if (lane && cat) {
    const it = lane.items.find((n) => world >= n.w0 && world < n.w1);
    if (it) {
      const a = locate(cat, it.w0);
      const z = locate(cat, Math.max(it.w0, it.w1 - 1));
      const span = a && z ? `${escapeHtml(a.name)}:${formatInt(a.local + 1)}–${formatInt(z.local + 1)}` : '';
      const arrow = it.strand === '-' ? ' (−)' : it.strand === '+' ? ' (+)' : '';
      tooltip.innerHTML =
        `<div class="line"><b>${escapeHtml(it.name)}</b>${arrow}</div>` +
        (span ? `<div class="line"><span>${span}</span></div>` : '') +
        `<div class="line"><span>${escapeHtml(lane.label)}</span></div>`;
      const r = plotRoot.getBoundingClientRect();
      let tx = e.clientX - r.left + 14;
      let ty = e.clientY - r.top - 34;
      tooltip.hidden = false;
      const tw = tooltip.offsetWidth;
      if (tx + tw > r.width - 8) tx = e.clientX - r.left - tw - 14;
      tooltip.style.left = `${Math.max(4, tx)}px`;
      tooltip.style.top = `${Math.max(4, ty)}px`;
      laneTipOn = true;
      return;
    }
  }
  if (laneTipOn) {
    tooltip.hidden = true;
    laneTipOn = false;
  }
}

overlay.addEventListener('pointerup', (e) => {
  if (!state.view) return;
  if (selecting && state.selection) {
    const s = state.selection;
    const { pw, ph } = state.sizes;
    if (Math.abs(s.x1 - s.x0) > 8 && Math.abs(s.y1 - s.y0) > 8) {
      state.view.fitRect(
        state.view.pxToWorldX(s.x0, pw),
        state.view.pxToWorldY(s.y0, ph),
        state.view.pxToWorldX(s.x1, pw),
        state.view.pxToWorldY(s.y1, ph),
        pw,
        ph,
      );
    }
  }
  selecting = false;
  state.selection = null;
  panning = false;
  overlay.style.cursor = 'crosshair';
  try {
    overlay.releasePointerCapture(e.pointerId);
  } catch {
    // Already released.
  }
  markDirty();
});

overlay.addEventListener('pointerleave', () => {
  state.cursor = null;
  pendingHover = null;
  laneTipOn = false;
  setHover(null, null);
  readout.textContent = '—';
  markDirty();
});

overlay.addEventListener(
  'wheel',
  (e) => {
    if (!state.view) return;
    e.preventDefault();
    const p = plotXY(/** @type {PointerEvent} */ (/** @type {unknown} */ (e)));
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    // Trackpad pinch arrives as ctrl+wheel (Chrome/Firefox) with small
    // deltas — give it real leverage; plain wheel/two-finger scroll zooms
    // at the normal rate.
    const sens = e.ctrlKey ? 0.012 : 0.0022;
    const factor = Math.min(5, Math.max(0.2, Math.exp(-e.deltaY * scale * sens)));
    const axes = e.altKey ? 'x' : 'both';
    const { pw, ph } = state.sizes;
    state.view.zoomAt(p.x, p.y, factor, pw, ph, axes);
    markDirty();
  },
  { passive: false },
);

// Safari on macOS delivers trackpad pinch as proprietary gesture events (no
// ctrl+wheel) — without these handlers a pinch zooms the page instead of the
// plot. `scale` is cumulative since gesturestart, so zoom by the ratio.
let gestureLastScale = 1;
overlay.addEventListener(
  'gesturestart',
  (e) => {
    e.preventDefault();
    gestureLastScale = /** @type {any} */ (e).scale ?? 1;
  },
  { passive: false },
);
overlay.addEventListener(
  'gesturechange',
  (e) => {
    e.preventDefault();
    if (!state.view) return;
    const ev = /** @type {any} */ (e);
    const s = ev.scale ?? 1;
    const factor = Math.min(5, Math.max(0.2, s / (gestureLastScale || 1)));
    gestureLastScale = s;
    const p = plotXY(ev);
    const { pw, ph } = state.sizes;
    state.view.zoomAt(p.x, p.y, factor, pw, ph, 'both');
    markDirty();
  },
  { passive: false },
);
overlay.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

overlay.addEventListener('dblclick', (e) => {
  if (!state.view) return;
  const p = plotXY(/** @type {PointerEvent} */ (/** @type {unknown} */ (e)));
  const { pw, ph } = state.sizes;
  state.view.zoomAt(p.x, p.y, e.shiftKey ? 1 / 2.2 : 2.2, pw, ph, 'both');
  markDirty();
});

// Hover picking, throttled to the render loop.
setInterval(() => {
  if (!pendingHover) return;
  const e = pendingHover;
  pendingHover = null;
  if (!state.view || !state.grid || !state.data || panning || selecting) return;
  const p = plotXY(/** @type {PointerEvent} */ (e));
  const { pw, ph } = state.sizes;
  if (p.x < 0 || p.y < 0 || p.x > pw || p.y > ph) {
    setHover(null, null);
    return;
  }
  if (heatMode()) {
    // Cell readout instead of segment picking.
    setHover(null, null);
    if (heatBin) {
      const wx = state.view.pxToWorldX(p.x, pw);
      const wy = state.view.pxToWorldY(p.y, ph);
      const v = heatAt(heatBin, wx, wy);
      hoverCard.className = v > 0 ? '' : 'empty';
      hoverCard.textContent = v > 0
        ? `tile identity ≥ ${(v * 100).toFixed(1)}% (ramp ${(heatRange.lo * 100).toFixed(1)}–${(heatRange.hi * 100).toFixed(1)}%)`
        : 'empty tile';
    }
    return;
  }
  const d = displayOpts();
  const hit = state.grid.nearest(state.view, pw, ph, p.x, p.y, 7);
  if (hit) {
    const i = hit.index;
    const visible = segmentVisible(state.data.segments, i, d);
    setHover(visible ? i : null, /** @type {PointerEvent} */ (e));
  } else {
    setHover(null, null);
  }
}, 40);

/**
 * @param {number | null} index
 * @param {PointerEvent | MouseEvent | null} e
 */
function setHover(index, e) {
  if (index === state.hoverIndex && index === null) return;
  const changed = index !== state.hoverIndex;
  state.hoverIndex = index;
  if (index == null || !state.data) {
    tooltip.hidden = true;
    if (changed) {
      hoverCard.className = 'empty';
      hoverCard.textContent = 'nothing under the cursor';
      markDirty();
    }
    return;
  }
  const html = describeSegment(index);
  hoverCard.className = '';
  hoverCard.innerHTML = html;
  tooltip.innerHTML = html;
  if (e) {
    const r = plotRoot.getBoundingClientRect();
    let tx = e.clientX - r.left + 14;
    let ty = e.clientY - r.top + 14;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    if (tx + tw > r.width - 8) tx = e.clientX - r.left - tw - 14;
    if (ty + th > r.height - 8) ty = e.clientY - r.top - th - 14;
    tooltip.style.left = `${Math.max(4, tx)}px`;
    tooltip.style.top = `${Math.max(4, ty)}px`;
  }
  if (changed) markDirty();
}

/** @param {number} i */
function describeSegment(i) {
  const data = /** @type {PlotData} */ (state.data);
  const s = data.segments;
  const tA = locate(data.target, s.x[i]);
  const tB = locate(data.target, Math.min(s.x[i] + s.dx[i] - 1, data.target.total - 1));
  const qA = locate(data.query, s.y[i]);
  const qB = locate(data.query, Math.min(s.y[i] + s.dy[i] - 1, data.query.total - 1));
  const rev = s.strand[i] === 1;
  const ident = (s.identity[i] * 100).toFixed(s.identity[i] >= 0.999 ? 0 : 1);
  /** @param {ReturnType<typeof locate>} a @param {ReturnType<typeof locate>} b */
  const span = (a, b) =>
    a && b
      ? a.name === b.name
        ? `${escapeHtml(a.name)} : ${formatInt(a.local + 1)}–${formatInt(b.local + 1)}`
        : `${escapeHtml(a.name)}:${formatInt(a.local + 1)} → ${escapeHtml(b.name)}:${formatInt(b.local + 1)}`
      : '?';
  return (
    `<div class="line"><span>target</span><span>${span(tA, tB)}</span></div>` +
    `<div class="line"><span>query</span><span>${span(qA, qB)}</span></div>` +
    `<div class="line"><span>${rev ? 'reverse' : 'forward'} · ${formatBp(s.dx[i])}</span>` +
    `<span class="t-ident">${ident}% identity</span></div>`
  );
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** @param {{x: number, y: number}} p */
function updateReadout(p) {
  if (!state.view || !state.data) return;
  const { pw, ph } = state.sizes;
  const wx = state.view.pxToWorldX(p.x, pw);
  const wy = state.view.pxToWorldY(p.y, ph);
  const t = locate(state.data.target, wx);
  const q = locate(state.data.query, wy);
  readout.textContent =
    t && q
      ? `target ${t.name} : ${formatInt(t.local + 1)}   ·   query ${q.name} : ${formatInt(q.local + 1)}`
      : '—';
}

// --------------------------------------------------------------------------
// Keyboard

window.addEventListener('keydown', (e) => {
  const t = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target : null);
  // Only typing contexts swallow shortcuts — a residually-focused button
  // (just clicked) must not eat R/G/arrow keys.
  if (t && t.closest('input, select, textarea')) return;
  if (!state.view) return;
  const { pw, ph } = state.sizes;
  const pan = 80;
  switch (e.key) {
    case 'r':
    case 'R':
    case '0':
      fitView();
      break;
    case '+':
    case '=':
      state.view.zoomAt(pw / 2, ph / 2, 1.5, pw, ph, 'both');
      break;
    case '-':
    case '_':
      state.view.zoomAt(pw / 2, ph / 2, 1 / 1.5, pw, ph, 'both');
      break;
    case 'ArrowLeft':
      state.view.panPx(pan, 0);
      break;
    case 'ArrowRight':
      state.view.panPx(-pan, 0);
      break;
    case 'ArrowUp':
      state.view.panPx(0, pan);
      break;
    case 'ArrowDown':
      state.view.panPx(0, -pan);
      break;
    case 'p':
    case 'P':
      state.fpsOn = !state.fpsOn;
      break;
    case 'f':
    case 'F':
      refineView();
      break;
    case '[':
    case ']': {
      const cur = parseLenOff(inMinLen.value, 0);
      let idx = 0;
      for (let i = 0; i < MINLEN_LADDER.length; i++) if (MINLEN_LADDER[i] <= cur) idx = i;
      idx = Math.max(0, Math.min(MINLEN_LADDER.length - 1, idx + (e.key === ']' ? 1 : -1)));
      setMinLen(MINLEN_LADDER[idx]);
      updateLegend();
      break;
    }
    case 'g':
    case 'G':
      /** @type {HTMLInputElement} */ ($('in-region')).focus();
      break;
    case '1':
      chkFwd.checked = !chkFwd.checked;
      break;
    case '2':
      chkRev.checked = !chkRev.checked;
      break;
    default:
      return;
  }
  e.preventDefault();
  markDirty();
});

// --------------------------------------------------------------------------
// Sidebar wiring

// k slider and its editable number stay in lockstep; the number accepts the
// full engine range (4..26) even though the slider starts at 8.
inK.addEventListener('input', () => {
  inKNum.value = inK.value;
});
inKNum.addEventListener('change', () => {
  const k = currentK();
  inKNum.value = String(k);
  inK.value = String(Math.min(26, Math.max(8, k)));
});
inWidth.addEventListener('input', () => {
  outWidth.textContent = inWidth.value;
  markDirty();
});
inMinIdent.addEventListener('input', () => {
  const v = Number(inMinIdent.value);
  outMinIdent.textContent = v <= state.identLo ? 'off' : `${(v * 100).toFixed(1)}%`;
  markDirty();
});
for (const el of [inMinLen, selColorMode]) {
  el.addEventListener('change', () => {
    updateLegend();
    markDirty();
  });
}
// Field, slider, and readout stay one value — live while typing/dragging.
inMinLen.addEventListener('input', () => setMinLen(parseLenOff(inMinLen.value, 0), { skipText: true }));
inMinLenRange.addEventListener('input', () => setMinLen(minLenFromSlider(Number(inMinLenRange.value))));
inMinLenRange.addEventListener('change', updateLegend);
for (const el of [chkFwd, chkRev, chkMinPx]) {
  el.addEventListener('change', () => {
    if (el !== chkMinPx && heatMode()) rebuildHeatmap();
    markDirty();
  });
}
chkAspect.addEventListener('change', fitView);

btnCompute.addEventListener('click', () => {
  if (state.fileTarget) computeKmer();
});
$('btn-demo2').addEventListener('click', () => void loadDemo());
$('btn-demo-real2').addEventListener('click', () => void loadFullChr17());
$('btn-hero').addEventListener('click', () => {
  // The README's hero region: select the T2T reference and stream the chr8
  // centromere's woven satellite arrays as a self-plot.
  selRef.value = 't2t';
  applyRefSelection(false);
  inRefRegion.value = 'chr8:44.2M-46.33M';
  void loadRefRegion('chr8:44.2M-46.33M');
});
chkOverlay.addEventListener('change', () => {
  updateLegend();
  markDirty();
});
const inRegion = /** @type {HTMLInputElement} */ ($('in-region'));
$('btn-region').addEventListener('click', () => jumpToRegion(inRegion.value));
inRegion.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') jumpToRegion(inRegion.value);
});
$('btn-cancel').addEventListener('click', cancelCompute);
$('btn-fit').addEventListener('click', fitView);

/**
 * Recompute the visible window at full density and merge the result into
 * the existing plot in place — coarse chromosome context everywhere else,
 * exact detail where you're looking. Axes, zoom, and the overlay stay put.
 * @param {boolean} [auto] triggered by the settle watcher: fail silently,
 *   and suppress the completion toast
 */
function refineView(auto = false) {
  if (state.computing) return;
  const d = state.data;
  if (!d || d.source !== 'kmer' || !state.view) {
    if (!auto) toast('Refine works on alignment-free plots (FASTA inputs).');
    return;
  }
  if (!state.fileTarget) {
    if (!auto) toast('The original FASTA buffers are no longer loaded — recompute first.');
    return;
  }
  const { pw, ph } = state.sizes;
  const b = state.view.bounds(pw, ph);
  const tx0 = Math.max(0, Math.floor(b.x0));
  const tx1 = Math.min(d.target.total, Math.ceil(b.x1));
  const qy0 = Math.max(0, Math.floor(b.y0));
  const qy1 = Math.min(d.query.total, Math.ceil(b.y1));
  if (tx1 - tx0 < 100 || qy1 - qy0 < 100) {
    if (!auto) toast('The visible window is too small to refine.');
    return;
  }
  refineQuiet = auto;
  autoRefinedSig = lastViewSig; // a window refined by hand needn't auto-refine again
  // Debug/automation stamp (globalThis.__dotdot.lastRefine).
  /** @type {any} */ (state).lastRefine = { auto, window: { tx0, tx1, qy0, qy1 } };
  // Full density plus a raised repeat budget: an explicit refine means
  // "spend the time here" — at full fit this deepens the WHOLE plot
  // (satellite cores especially), not just re-derives it.
  submitKmer({ ...matchOpts(), sample: 1, budgetX: 4 }, { tx0, tx1, qy0, qy1 });
}

// ---- auto-refine: settle-watcher over the view -----------------------------
// With "auto" on, resting ~1 s at a meaningfully zoomed view refines that
// window by itself — the zoom → refine loop with the second step removed.
// supersede() keeps rapid navigation cheap; the signature guard keeps any
// window from refining twice.
let lastViewSig = '';
let viewSettledAt = 0;
let autoRefinedSig = '';
let refineQuiet = false;

/** @param {number} now */
function autoRefineTick(now) {
  if (!state.view || !state.data) return;
  const { pw, ph } = state.sizes;
  const b = state.view.bounds(pw, ph);
  const sig = `${Math.round(b.x0)},${Math.round(b.x1)},${Math.round(b.y0)},${Math.round(b.y1)}`;
  if (sig !== lastViewSig) {
    lastViewSig = sig;
    viewSettledAt = now;
    return;
  }
  if (!chkAutoRefine.checked || state.computing) return;
  if (now - viewSettledAt < 900 || sig === autoRefinedSig) return;
  if (state.data.source !== 'kmer' || !state.fileTarget) return;
  const txSpan = Math.min(state.data.target.total, b.x1) - Math.max(0, b.x0);
  const qySpan = Math.min(state.data.query.total, b.y1) - Math.max(0, b.y0);
  const areaFrac = (txSpan * qySpan) / (state.data.target.total * state.data.query.total);
  if (txSpan < 100 || qySpan < 100 || areaFrac > 0.25) return;
  refineView(true);
}

/**
 * @param {{segments: import('./core/types.js').SegmentStore, window: {tx0:number,tx1:number,qy0:number,qy1:number}, identMin: number}} msg
 */
function onRegionRefined(msg) {
  const d = state.data;
  if (!d) return;
  const w = msg.window;
  const s = d.segments;
  const ns = msg.segments;
  // Old segments fully inside the window are superseded by the refined pass;
  // edge-crossers stay (their in-window parts briefly coexist — harmless).
  /** @type {number[]} */
  const keep = [];
  for (let i = 0; i < s.count; i++) {
    const inside =
      s.x[i] >= w.tx0 && s.x[i] + s.dx[i] <= w.tx1 && s.y[i] >= w.qy0 && s.y[i] + s.dy[i] <= w.qy1;
    if (!inside) keep.push(i);
  }
  const total = keep.length + ns.count;
  if (total > 20_000_000) {
    toast('Refining this window would exceed the segment budget — narrow the view or raise min match length.', true);
    return;
  }
  const merged = allocSegments(total);
  for (let j = 0; j < keep.length; j++) copySegmentRow(merged, j, s, keep[j]);
  blitSegments(merged, keep.length, ns);

  d.segments = merged;
  renderer.setData(merged);
  state.grid = null;
  state.hoverIndex = null;
  lastHeatSig = ''; // refined data: rebin on next settle
  setTimeout(() => {
    if (state.data === d) {
      state.grid = new SegmentGrid(merged, d.target.total, d.query.total);
    }
  }, 30);
  if (msg.identMin < state.identLo) {
    state.identLo = Math.max(0, Math.floor(msg.identMin * 100) / 100);
    inMinIdent.min = String(state.identLo);
    updateLegend();
  }
  updateStats();
  if (!refineQuiet) {
    const lenFilter = parseLenOff(inMinLen.value, 0);
    toast(
      `Refined ${formatBp(w.tx1 - w.tx0)} × ${formatBp(w.qy1 - w.qy0)} at full detail: ` +
        `+${formatCount(ns.count)} segments in the window.` +
        (lenFilter > 0 ? ` Min segment length is ${formatBp(lenFilter)} — lower it to see the fine structure.` : ''),
    );
  }
  refineQuiet = false;
  markDirty();
}
$('btn-refine').addEventListener('click', () => refineView());
btnZoomRefine.addEventListener('click', () => refineView());

/** @param {number} f */
function zoomStep(f) {
  if (!state.view) return;
  const { pw, ph } = state.sizes;
  state.view.zoomAt(pw / 2, ph / 2, f, pw, ph, 'both');
  markDirty();
}
$('btn-zoom-in').addEventListener('click', () => zoomStep(1.6));
$('btn-zoom-out').addEventListener('click', () => zoomStep(1 / 1.6));
$('btn-zoom-fit').addEventListener('click', fitView);

// Some WebKit-based browsers (DuckDuckGo among them) implement trackpad
// pinch as native page magnification the page cannot intercept. Detect it
// once and point at the plot's own zoom paths.
let pageZoomHinted = false;
window.visualViewport?.addEventListener('resize', () => {
  const vv = window.visualViewport;
  if (!vv || pageZoomHinted || vv.scale <= 1.1) return;
  pageZoomHinted = true;
  toast(
    'Your browser magnified the whole page (its own pinch gesture). Press ⌘0 to reset it — ' +
      'then zoom the plot with two-finger scroll, double-click, or the +/− buttons.',
  );
});
$('btn-clear').addEventListener('click', () => {
  // Kill in-flight work first: without this, a compute finishing later
  // passes the id gate and repopulates the app the UI says is empty (and
  // the worker keeps holding its parse cache).
  worker.terminate();
  spawnWorker();
  stopPool();
  heatBin = null;
  lastHeatSig = '';
  activeReq = -1;
  setComputing(false);
  newLoadIntent();
  boundActions = null;
  lastKmer = null;
  state.data = null;
  state.grid = null;
  state.view = null;
  state.fileTarget = null;
  state.fileQuery = null;
  state.hoverIndex = null;
  clearOverlay();
  renderer.clearData();
  glcanvas.hidden = true;
  setChip('chip-target', null);
  setChip('chip-query', null);
  setChip('chip-paf', null);
  emptyState.hidden = false;
  btnPng.disabled = true;
  btnSvg.disabled = true;
  btnShare.disabled = true;
  setRefineEnabled(false);
  panelDetail.hidden = true;
  plotStats.hidden = true;
  closeStatsPop();
  annoLanes = { x: [], y: [] };
  syncAnnoLayout();
  lastAnnoSig = '';
  segScan = { ref: null, fwd: 0, rev: 0, bpFwd: 0, bpRev: 0 };
  statsPopCache = { ref: null, mode: '', html: '' };
  btnCompute.disabled = true;
  btnCompute.textContent = 'Compute dot plot';
  legendEl.className = 'empty';
  legendEl.textContent = 'no data';
  statsEl.innerHTML = '';
  markDirty();
});

btnPng.addEventListener('click', () => {
  const stashCursor = state.cursor;
  const stashFps = state.fpsOn;
  try {
    state.cursor = null;
    state.fpsOn = false;
    draw(window.devicePixelRatio || 1);
    exportPng({
      underlay,
      glCanvas: glcanvas,
      overlay,
      dpr: window.devicePixelRatio || 1,
      filename: 'dotdot.png',
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  } finally {
    state.cursor = stashCursor;
    state.fpsOn = stashFps;
    markDirty();
  }
});

btnShare.addEventListener('click', async () => {
  if (!state.data || !state.view) return;
  const { pw, ph } = state.sizes;
  const b = state.view.bounds(pw, ph);
  const hash = buildViewHash({
    x0: b.x0,
    x1: b.x1,
    y0: b.y0,
    y1: b.y1,
    len: inMinLen.value.trim() || 'off',
    // The slider's floor position means "off" — only a raised value travels.
    ident: Number(inMinIdent.value) > state.identLo ? Number(inMinIdent.value) : 0,
    draw: heatMode() ? 'heat' : 'seg',
    fwd: chkFwd.checked,
    rev: chkRev.checked,
    auto: chkAutoRefine.checked,
  });
  // Non-default compute options ride along so the recipient's plot matches.
  const q = new URLSearchParams(shareBase ?? '');
  const mo = /** @type {any} */ (matchOpts());
  if (mo.k !== 15) q.set('k', String(mo.k));
  if (mo.maxGap !== 64) q.set('gap', String(mo.maxGap));
  if (mo.maxOcc !== 200) q.set('occ', String(mo.maxOcc));
  if (mo.minRunLen !== 0) q.set('minrun', String(mo.minRunLen));
  if (mo.sample !== 'auto') q.set('sample', String(mo.sample));
  const qs = q.toString();
  const url = `${location.origin}${location.pathname}${qs ? '?' + qs : ''}${hash}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(
      shareBase
        ? 'View link copied — it reproduces this exact data, viewport, and settings.'
        : 'Link copied — note: locally loaded files are not in it, only the viewport and settings.',
    );
  } catch {
    inRegion.value = url;
    toast('Could not reach the clipboard — the link is in the region box, ready to copy.');
  }
});

btnSvg.addEventListener('click', () => {
  if (!state.data || !state.view) return;
  if (heatMode()) {
    toast('SVG exports the segment view — switch “draw as” to segments (PNG captures the heatmap).');
    return;
  }
  if (!state.grid) {
    toast('Still indexing for export — try again in a second.');
    return;
  }
  try {
    exportSvg({
      data: state.data,
      grid: state.grid,
      view: state.view,
      vpW: state.sizes.cssW,
      vpH: state.sizes.cssH,
      theme,
      mode,
      opts: displayOpts(),
      annoX: annoLanes.x,
      annoY: annoLanes.y,
      filename: 'dotdot.svg',
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
});

// --------------------------------------------------------------------------
// Legend / stats / toast

function updateLegend() {
  if (!state.data) return;
  const cm = buildColormap(mode);
  const colorMode = Number(selColorMode.value);
  const swFwd = $('sw-fwd');
  const swRev = $('sw-rev');
  swFwd.style.background = cm.fwdFlat;
  swRev.style.background = cm.revFlat;
  legendEl.className = '';
  if (heatMode()) {
    // The heatmap's ramp is contrast-stretched to the observed tile range.
    legendEl.innerHTML =
      `<div class="row"><span class="lab">tile</span><span class="ramp" style="background:${cm.rampCss(0)}"></span></div>` +
      `<div class="row"><span class="lab"></span><span class="lab">${(heatRange.lo * 100).toFixed(1)}% identity</span><span style="flex:1"></span><span class="lab">${(heatRange.hi * 100).toFixed(1)}%</span></div>`;
  } else if (colorMode === 0) {
    const lo = `${Math.round(state.identLo * 100)}%`;
    legendEl.innerHTML =
      `<div class="row"><span class="lab">fwd</span><span class="ramp" style="background:${cm.rampCss(0)}"></span></div>` +
      `<div class="row"><span class="lab">rev</span><span class="ramp" style="background:${cm.rampCss(1)}"></span></div>` +
      `<div class="row"><span class="lab"></span><span class="lab">${lo} identity</span><span style="flex:1"></span><span class="lab">100%</span></div>`;
  } else {
    legendEl.innerHTML =
      `<div class="row"><span class="swatch" style="background:${cm.fwdFlat}"></span> forward matches</div>` +
      `<div class="row"><span class="swatch" style="background:${cm.revFlat}"></span> reverse matches</div>`;
  }
  if (state.overlay && chkOverlay.checked) {
    legendEl.innerHTML +=
      `<div class="row"><span class="lab" style="color:var(--ink)">◆—◆</span>` +
      `<span>aligner calls (overlay)</span></div>`;
  }
}

// One cached pass over the store backs the light widget: strand split and
// aligned bp. ~20 ms at 8M rows, and only when the segments object changes.
/** @type {{ref: import('./core/types.js').SegmentStore | null, fwd: number, rev: number, bpFwd: number, bpRev: number}} */
let segScan = { ref: null, fwd: 0, rev: 0, bpFwd: 0, bpRev: 0 };

/** @param {import('./core/types.js').SegmentStore} s */
function scanSegments(s) {
  if (segScan.ref === s) return segScan;
  let fwd = 0;
  let bpFwd = 0;
  let bpRev = 0;
  for (let i = 0; i < s.count; i++) {
    if (s.strand[i] === 0) {
      fwd++;
      bpFwd += s.dx[i];
    } else {
      bpRev += s.dx[i];
    }
  }
  segScan = { ref: s, fwd, rev: s.count - fwd, bpFwd, bpRev };
  return segScan;
}

function updateStats() {
  const data = state.data;
  if (!data) return;
  const s = data.stats;
  const sc = scanSegments(data.segments);
  const cm = buildColormap(mode);
  /** @param {string} c */
  const sw = (c) => `<span class="swatch" style="background:${c}"></span>`;
  const secs = s.elapsedMs / 1000;
  const rate = secs > 0 ? `${formatCount(data.segments.count / secs)}/s` : '—';
  const rows = [
    ['segments', `${formatCount(data.segments.count)} · ${rate}`],
    [`${sw(cm.fwdFlat)}forward`, `${formatCount(sc.fwd)} · ${formatBp(sc.bpFwd)}`],
    [`${sw(cm.revFlat)}reverse`, `${formatCount(sc.rev)} · ${formatBp(sc.bpRev)}`],
    ['target', `${data.target.names.length} seq · ${formatBp(data.target.total)}`],
    ['query', `${data.query.names.length} seq · ${formatBp(data.query.total)}`],
    ['compute', `${secs.toFixed(2)} s · ${data.source === 'kmer' ? 'alignment-free' : 'PAF import'}`],
  ];
  if (s.skippedLines) rows.push(['skipped lines', String(formatInt(s.skippedLines))]);
  statsEl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd title="${v}">${v}</dd>`).join('');
  plotStats.hidden = false;
}

// ---- distributions popup ---------------------------------------------------
// The compute-priced tier: whole-store histograms + the index's occurrence
// spectrum, built on demand and cached per segments object and theme.

const statsPop = document.createElement('div');
statsPop.id = 'stats-pop';
statsPop.hidden = true;
document.body.append(statsPop);
statsPop.addEventListener('click', (e) => {
  if (e.target === statsPop) closeStatsPop();
});

function closeStatsPop() {
  statsPop.hidden = true;
}

/** @type {{ref: unknown, mode: string, html: string}} */
let statsPopCache = { ref: null, mode: '', html: '' };

function openStatsPop() {
  const d = state.data;
  if (!d) return;
  if (statsPopCache.ref !== d.segments || statsPopCache.mode !== mode) {
    statsPopCache = { ref: d.segments, mode, html: buildStatsPopHtml(d) };
  }
  statsPop.innerHTML = statsPopCache.html;
  statsPop.hidden = false;
  const x = statsPop.querySelector('.stats-close');
  if (x) x.addEventListener('click', closeStatsPop);
}

/** @param {PlotData} d */
function buildStatsPopHtml(d) {
  const cm = buildColormap(mode);
  const sc = scanSegments(d.segments);
  const dist = segmentDistributions(d.segments);
  const legend =
    `<span class="chip-leg"><span class="swatch" style="background:${cm.fwdFlat}"></span>forward</span>` +
    `<span class="chip-leg"><span class="swatch" style="background:${cm.revFlat}"></span>reverse</span>`;
  let html =
    `<div class="stats-card">` +
    `<div class="stats-head"><h3>Plot composition</h3><button class="stats-close" aria-label="close">×</button></div>` +
    `<p class="stats-sum">${formatInt(d.segments.count)} segments — ` +
    `${formatCount(sc.fwd)} forward (${formatBp(sc.bpFwd)}), ` +
    `${formatCount(sc.rev)} reverse (${formatBp(sc.bpRev)}). ` +
    `Base layer only; display filters are not applied here.</p>`;
  if (dist) {
    const lenLabels = ladderLabels(dist.lengths.edges);
    html +=
      `<div class="stats-chart"><h4>segment length <span class="axis-note">log count · bins ≤ label</span>${legend}</h4>` +
      groupedBarsSVG({
        binLabels: lenLabels,
        series: [
          { name: 'forward', color: cm.fwdFlat, values: dist.lengths.fwd },
          { name: 'reverse', color: cm.revFlat, values: dist.lengths.rev },
        ],
      }) +
      '</div>';
    const idLabels = [];
    for (let i = 0; i < dist.identity.fwd.length; i++) {
      idLabels.push(`${((dist.identity.lo + i * dist.identity.width) * 100).toFixed(1)}%`);
    }
    html +=
      `<div class="stats-chart"><h4>identity <span class="axis-note">log count</span>${legend}</h4>` +
      groupedBarsSVG({
        binLabels: idLabels,
        series: [
          { name: 'forward', color: cm.fwdFlat, values: dist.identity.fwd },
          { name: 'reverse', color: cm.revFlat, values: dist.identity.rev },
        ],
      }) +
      '</div>';
  }
  const km = d.stats.kmer;
  if (km) {
    const occ = occupancyBins(km.occCount);
    html +=
      `<div class="stats-chart"><h4>k-mer occurrence spectrum <span class="axis-note">distinct ${km.k}-mers · log count</span></h4>` +
      groupedBarsSVG({
        binLabels: occ.map((o) => o.label),
        series: [{ name: 'distinct k-mers', color: cm.fwdFlat, values: occ.map((o) => o.count) }],
      }) +
      `<p class="stats-sum">${formatCount(km.distinct)} distinct ${km.k}-mers · ` +
      `${formatCount(km.entries)} indexed positions` +
      (km.stride > 1 ? ` (1/${km.stride} stride)` : '') +
      (km.qSample > 1 ? ` · query sampled 1/${km.qSample}` : '') +
      ` · repeat cutoff ${formatInt(km.maxOcc)}×. The x axis is how often a k-mer occurs in the ` +
      `target — the right-hand tail is the repeat fraction of the genome.</p></div>`;
  }
  html += '</div>';
  return html;
}
btnStatsDetail.addEventListener('click', openStatsPop);

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** @param {string} msg @param {boolean} [isError] */
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = isError ? 'error' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), isError ? 30000 : 6000);
}

/** @param {string} msg */
function fatal(msg) {
  emptyState.innerHTML = `<p style="max-width:420px"><strong>dotdot can’t start:</strong> ${msg}</p>`;
}

// --------------------------------------------------------------------------
// Help popovers: little "?" buttons across the UI, one shared popover.

const HELP = {
  controls:
    '<b>Mouse / trackpad</b><br>drag — pan · two-finger scroll or wheel — zoom (Alt = x-only) · ' +
    'pinch — zoom (Safari/Chrome; some browsers reserve pinch for page magnification — use the ' +
    'on-plot +/− buttons there) · shift-drag — box zoom · double-click — zoom in (shift = out) · ' +
    'hover — inspect a match<br><b>Keys</b><br>' +
    '<kbd>R</kbd>/<kbd>0</kbd> fit · <kbd>F</kbd> refine view · <kbd>[</kbd>/<kbd>]</kbd> min ' +
    'segment length down/up · <kbd>G</kbd> region box · <kbd>+</kbd>/<kbd>−</kbd> zoom · ' +
    'arrows pan · <kbd>1</kbd>/<kbd>2</kbd> strand toggles · <kbd>P</kbd> fps meter',
  data:
    'Target FASTA = x axis, query FASTA = y axis (one file → self-plot). Each button ' +
    '<b>multi-selects</b>: several files stack onto that axis as one plot, every sequence keeping ' +
    'its own ruler, with alternating shading separating regions. Drop 3+ FASTAs at once and the ' +
    'first becomes the target, the rest the query. dotdot computes matches itself, ' +
    'alignment-free; gzipped (and bgzip) files are fine.',
  ref:
    'Built-in reference genomes, fetched on demand as <b>byte ranges</b> from UCSC’s 2bit files — ' +
    'the genome itself never downloads. Type any region in genome-browser coordinates ' +
    '(<b>chrX:57.8M-60.7M</b>, 1-based) and Load: with no query FASTA the region plots against ' +
    'itself (try the centromere showcase presets — satellite arrays are spectacular); with a ' +
    'query FASTA loaded, the query dots against the region. Coordinates shown for reference ' +
    'regions are true genomic positions, and the region-jump box accepts them too. Shareable: ' +
    '?ref=t2t&refregion=chrX:57.8M-60.7M.',
  matching:
    'These change what is <i>computed</i> — press Recompute after editing. The Display section ' +
    'below applies instantly, without recomputing.',
  k:
    'Exact-match word size — type any value from <b>4 to 26</b> (the slider covers 8+). Longer k ' +
    '→ fewer chance matches and faster, but blinder to diverged sequence; 15 suits most ' +
    'comparisons, 16–21 helps at chromosome scale. k above 16 doubles index memory.',
  gap:
    'Merge co-linear matches on one diagonal across up to this many mismatched bases. Type any ' +
    'value ("64", "1kb", …) — presets are suggestions. Larger values give longer, cleaner ' +
    'segments; the bridged mismatch shows up as reduced identity.',
  occ:
    'Skip k-mers occurring more often than this in the target — repeat masking. Any number ' +
    'works; presets are suggestions. At genome scale the cutoff also auto-tightens using the ' +
    'index’s own occurrence histogram, so Alu-scale repeat families can’t flood the plot.',
  minrun:
    'Drop merged runs shorter than this at compute time ("off", "30", "1kb", any value). At ' +
    'genome scale a small evidence filter applies automatically.',
  sample:
    '<b>auto</b> thins matching on big inputs (test every Nth query position, sized to the ' +
    'data) so chromosomes compute in minutes. Set a number to pin it, or <b>off</b> for full ' +
    'density — exact but slow at chromosome scale. Tip: keep auto for the overview, zoom in, ' +
    'then hit <b>Refine view</b> to recompute just the window at full detail.',
  annotations:
    'Reference annotation tracks, streamed on demand from UCSC bigBeds as <b>byte ranges</b> — ' +
    'the track files never download. Lanes appear in the axis margins for any sequence named ' +
    'like a chromosome of the annotation genome (the selected reference, else T2T) — including ' +
    'reference slices like <b>chr17_ROI10.9</b>, placed by their true coordinates. Fetches ' +
    'follow the view: pan or zoom and the lanes update when you settle. <b>Hover a lane item</b> ' +
    'for its name, span, and strand. CenSat colors are the satellite-family colors from the ' +
    'track itself.',
  drawmode:
    '<b>segments</b> draws every match as a line — the exact view. <b>identity heatmap</b> bins ' +
    'the visible matches into tiles colored by the best identity seen in each (the ' +
    'StainedGlass-style satellite figure): dense repeat fabric becomes a readable identity ' +
    'landscape. Tiles re-bin when you rest; strand checkboxes choose what is binned; hover ' +
    'reads a tile; the aligner overlay still draws on top. PNG captures it (SVG stays ' +
    'segment-only).',
  detail:
    'The exploration dial, always at hand. <b>Min segment length</b> filters what is <i>drawn</i> ' +
    '(never what was computed): low reveals the repeat fabric, high shows clean structure — drag ' +
    'the slider, type an exact value, or press <kbd>[</kbd>/<kbd>]</kbd> from the plot. Dense ' +
    'results pick a sane starting value automatically. <b>Refine view</b> lives below, with ' +
    '<b>auto</b> to refine as you go.',
  refine:
    'Recomputes the <i>visible window</i> at full density with a raised repeat budget, merging ' +
    'it into the plot in place — axes, zoom, and the aligner overlay stay put. Press <kbd>F</kbd> ' +
    'or the ✦ button by the zoom controls; it works at <b>any</b> zoom, including full fit — ' +
    'refining a whole centromere window digs deeper into its repeat families. With <b>auto</b> ' +
    'checked, resting a moment at a zoomed view refines it by itself. Needs the FASTA inputs ' +
    'still loaded.',
  share:
    'Copies a link that reproduces this exact view: the data (when it came from a reference, ' +
    'the demo, or URLs), the viewport, display settings, and any non-default matching options. ' +
    'Locally loaded files cannot travel in a link — everything else can. Paste it anywhere; ' +
    'opening it replays the compute and lands on the same pixels.',
  minident:
    'Hide segments below this identity (matched fraction after gap bridging; for aligner PAFs, ' +
    'nmatch/alnlen). Instant — nothing recomputes.',
  strands:
    'Forward matches are blue; reverse-complement matches are orange — inversions appear as ' +
    'orange anti-diagonals. Toggle with keys <kbd>1</kbd> and <kbd>2</kbd>.',
  colorby:
    '“identity” shades each segment by its matched fraction (legend ramps); “strand only” uses ' +
    'flat blue/orange.',
  minpx:
    'Stretch tiny matches to a minimum on-screen size so small features remain visible when ' +
    'zoomed way out.',
  aspect: 'Lock both axes to the same bp-per-pixel scale, so perfect matches run at exactly 45°.',
  region:
    'Jump to a target region: <b>chr17:18.3M-19.4M</b>, a bare sequence name, or ' +
    '<b>100,000-250,000</b>. The query axis frames whatever maps there; when a region maps to ' +
    'several places (other haplotype, duplications), pressing Go again cycles through them.',
  overlay:
    'Drop an aligner’s PAF on an existing plot and its calls draw as ink lines with diamond ' +
    'breakpoint markers over the alignment-free layer — the aligner’s story against the raw ' +
    'sequence structure. Display filters never touch the overlay.',
};

const helpPop = document.createElement('div');
helpPop.id = 'help-pop';
helpPop.hidden = true;
document.body.append(helpPop);

/** @type {HTMLElement | null} */
let helpAnchor = null;

function closeHelp() {
  helpPop.hidden = true;
  helpAnchor = null;
}

document.addEventListener(
  'click',
  (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const btn = t.closest('.help');
    if (btn instanceof HTMLElement) {
      // Keep the click from reaching the label/control underneath.
      e.preventDefault();
      e.stopPropagation();
      if (helpAnchor === btn) {
        closeHelp();
        return;
      }
      const html = HELP[/** @type {keyof typeof HELP} */ (btn.dataset.help ?? '')];
      if (!html) return;
      helpPop.innerHTML = html;
      helpPop.hidden = false;
      helpAnchor = btn;
      const r = btn.getBoundingClientRect();
      helpPop.style.left = '0px';
      helpPop.style.top = '0px';
      const pw = helpPop.offsetWidth;
      const ph = helpPop.offsetHeight;
      let x = r.left;
      let y = r.bottom + 6;
      if (x + pw > innerWidth - 8) x = innerWidth - pw - 8;
      if (y + ph > innerHeight - 8) y = r.top - ph - 6;
      helpPop.style.left = `${Math.max(4, x)}px`;
      helpPop.style.top = `${Math.max(4, y)}px`;
    } else if (!helpPop.hidden && !t.closest('#help-pop')) {
      closeHelp();
    }
  },
  true,
);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeHelp();
    closeStatsPop();
  }
});

// --------------------------------------------------------------------------
// URL parameters: ?demo=1 | ?paf=url | ?target=url[&query=url] (+ k, gap, occ)

async function initFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has('k')) {
    inKNum.value = p.get('k') ?? inKNum.value;
    inK.value = String(Math.min(26, Math.max(8, currentK())));
  }
  if (p.has('gap')) inGap.value = p.get('gap') ?? inGap.value;
  if (p.has('occ')) inMaxOcc.value = p.get('occ') ?? inMaxOcc.value;
  if (p.has('minrun')) inMinRun.value = p.get('minrun') ?? inMinRun.value;
  if (p.has('sample')) inSample.value = p.get('sample') ?? inSample.value;
  const urlRegion = p.get('region');
  if (urlRegion) queuedActions = { ...(queuedActions ?? {}), region: urlRegion };
  try {
    if (p.has('ref')) {
      if (p.has('query')) {
        const q = await fetchAsFile(/** @type {string} */ (p.get('query')));
        setFasta('query', q);
      }
      selRef.value = p.get('ref') ?? '';
      applyRefSelection(false);
      const ref = currentRef();
      if (ref) {
        const region = p.get('refregion') ?? ref.defaultRegion;
        inRefRegion.value = region;
        await loadRefRegion(region);
      } else {
        toast(`Unknown reference “${p.get('ref')}” — available: ${REFERENCES.map((r) => r.id).join(', ')}.`, true);
      }
    } else if (p.has('demo')) {
      await loadDemo();
    } else if (p.has('paf')) {
      const f = await fetchAsFile(/** @type {string} */ (p.get('paf')));
      setChip('chip-paf', f);
      computePaf(f.buf);
      shareBase = new URLSearchParams({ paf: /** @type {string} */ (p.get('paf')) }).toString();
    } else if (p.has('target')) {
      if (p.has('overlay')) {
        const o = await fetchAsFile(/** @type {string} */ (p.get('overlay')));
        queuedActions = { ...(queuedActions ?? {}), overlay: o };
      }
      const t = await fetchAsFile(/** @type {string} */ (p.get('target')));
      const q = p.has('query') ? await fetchAsFile(/** @type {string} */ (p.get('query'))) : null;
      if (q) setFasta('query', q);
      setFasta('target', t);
      const sb = new URLSearchParams({ target: /** @type {string} */ (p.get('target')) });
      if (p.has('query')) sb.set('query', /** @type {string} */ (p.get('query')));
      if (p.has('overlay')) sb.set('overlay', /** @type {string} */ (p.get('overlay')));
      shareBase = sb.toString();
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

/** @param {string} url */
async function fetchAsFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const name = url.split('/').pop() || url;
  return { name, buf };
}

renderAnnoTracks();
void initFromUrl();
