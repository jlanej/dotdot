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
import { binIdentity, paintHeatmap, heatAt, binStretch, buildSatMask } from './render/heatmap.js';
import { spliceIntervals, SEGMENT_WALL_ERROR } from './core/kmer.js';
import { resolveRegion, parseBp } from './core/region.js';
import { buildViewHash, parseViewHash, writeMatchParams, readMatchParams } from './core/share.js';
import { GlRenderer } from './render/gl.js';
import { drawUnderlay, drawOverlay, LAYOUT, LANE_H, LANE_X0, LANE_Y0, setAnnotationLanes } from './render/axes.js';
import { buildColormap, buildMultiplicityTex, hexToRgb, oklchToSrgb, rgbToHex } from './render/colormap.js';
import { segmentDistributions, occupancyBins, groupedBarsSVG, ladderLabels } from './render/charts.js';
import { formatBp, formatInt, formatCount } from './render/format.js';
import { looksLikePaf } from './io/paf.js';
import { RemoteTwoBit, regionToFasta } from './io/twobit.js';
import { RemoteBigBed } from './io/bigbed.js';
import { REFERENCES, parseBrowserRegion, splitRegionList, splitCrossSpec } from './refs.js';
import { exportPng, compositeCanvases } from './export/png.js';
import { buildReport } from './export/report.js';
import { downloadBlob } from './export/download.js';
import { exportSvg } from './export/svg.js';
import { initHelp, closeHelp, BELONGS_METHODS } from './app/help.js';
import { statsPop, confirmPop, enterModal, closeConfirm, closeStatsPop, setConfirmDismiss, confirmCard } from './app/dialogs.js';
import { ViewSettle } from './app/settle.js';
import { LaneBuilder, multLane } from './app/annotations.js';

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
const chkMult = /** @type {HTMLInputElement} */ ($('chk-mult'));
const panelDetail = $('panel-detail');
const inSample = /** @type {HTMLInputElement} */ ($('in-sample'));
const inBudget = /** @type {HTMLInputElement} */ ($('in-budget'));
const chkFwd = /** @type {HTMLInputElement} */ ($('chk-fwd'));
const chkRev = /** @type {HTMLInputElement} */ ($('chk-rev'));
const selColorMode = /** @type {HTMLSelectElement} */ ($('sel-colormode'));
const selDrawMode = /** @type {HTMLSelectElement} */ ($('sel-drawmode'));
const inAniTiles = /** @type {HTMLInputElement} */ ($('in-anitiles'));
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
const btnReport = /** @type {HTMLButtonElement} */ ($('btn-report'));
const btnSvg = /** @type {HTMLButtonElement} */ ($('btn-svg'));
const btnRefine = /** @type {HTMLButtonElement} */ ($('btn-refine'));
const btnShare = /** @type {HTMLButtonElement} */ ($('btn-share'));
const btnStatsMin = /** @type {HTMLButtonElement} */ ($('btn-stats-min'));

/** The remembered scoreboard preference (private mode → default expanded). */
function readStatsPref() {
  try {
    return localStorage.getItem('dotdot.statsMin') === '1';
  } catch {
    return false;
  }
}

/**
 * Collapse/expand the on-plot scoreboard. Explicit clicks persist; the
 * small-viewport auto-collapse below applies without touching the stored
 * preference.
 * @param {boolean} min @param {boolean} [persist]
 */
function setStatsMin(min, persist = true) {
  plotStats.classList.toggle('min', min);
  btnStatsMin.textContent = min ? '▤ stats' : '−';
  btnStatsMin.title = min ? 'Expand stats' : 'Collapse stats';
  btnStatsMin.setAttribute('aria-label', btnStatsMin.title);
  btnStatsMin.setAttribute('aria-expanded', String(!min));
  if (!persist) return;
  try {
    localStorage.setItem('dotdot.statsMin', min ? '1' : '');
  } catch {
    // Private mode etc. — the toggle still works for the session.
  }
}
btnStatsMin.addEventListener('click', () => {
  statsAutoCollapsed = false; // an explicit click takes over from auto
  setStatsMin(!plotStats.classList.contains('min'));
});
if (readStatsPref()) setStatsMin(true, false);

// Small plot areas (split screens, projected demos): the expanded scoreboard
// can cover most of the data, so entering a tight viewport auto-collapses it
// — edge-triggered, preference untouched, restored when space returns.
let statsAutoCollapsed = false;
let statsWasTight = false;

/** @param {number} pw @param {number} ph plot area CSS px */
function autoCollapseStats(pw, ph) {
  const tight = pw < 480 || ph < 340;
  if (tight === statsWasTight) return;
  statsWasTight = tight;
  if (tight) {
    if (!plotStats.classList.contains('min')) {
      statsAutoCollapsed = true;
      setStatsMin(true, false);
    }
  } else if (statsAutoCollapsed) {
    statsAutoCollapsed = false;
    setStatsMin(readStatsPref(), false);
  }
}
const btnZoomRefine = /** @type {HTMLButtonElement} */ ($('btn-zoom-refine'));
const btnStatsDetail = /** @type {HTMLButtonElement} */ ($('btn-stats-detail'));
const btnBelongs = /** @type {HTMLButtonElement} */ ($('btn-belongs'));

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
  // The slider position is a log-scale index — announce the meaning instead.
  inMinLenRange.setAttribute('aria-valuetext', bp > 0 ? formatBp(bp) : 'off');
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

// ---- the settle bus ---------------------------------------------------------
// One view signature, four consumers. autoRefineTick feeds it each frame;
// annotations/heatmap/containment/auto-refine each hold a gate and ask
// "settled on something I haven't handled?" (js/app/settle.js — the reset
// sites are named invalidate() calls instead of scattered sig strings).
const settle = new ViewSettle();
const annoGate = settle.gate();
const heatGate = settle.gate();
const containGate = settle.gate();
const refineGate = settle.gate();

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
  if (state.data) updateStats(); // scoreboard swatches are theme-derived
  annoGate.invalidate(); // multiplicity-lane ink is theme-mixed; rebuild
  repaintHeatCanvas(); // heat/ANI pixels were painted in the old palette
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
/** @type {{window: {tx0:number,tx1:number,qy0:number,qy1:number}} | null} */
let lastContain = null;
/** @type {{rec: number | null} | null} */
let lastBelongs = null;
/** Which request kind a worker needData reply should resubmit. */
let lastSubmitKind = 'kmer';
/** User-raised segment wall in segments (0 = the 16M default). ~70 B of
 * RAM+GPU per segment redrawn every frame: a sizing default, not physics —
 * raisable with consent like every other ceiling here. */
let wallOverride = 0;

function spawnWorker() {
  workerGen = -1;
  worker = new Worker(new URL('./worker/compute.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.id !== activeReq) return;
    if (msg.type === 'progress') {
      progressLabel.textContent = msg.phase;
      setProgressPct(msg.frac * 100);
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
    } else if (msg.type === 'containResult') {
      setComputing(false);
      onContainResult(msg);
    } else if (msg.type === 'belongsResult') {
      setComputing(false);
      onBelongsResult(msg);
    } else if (msg.type === 'belongsGather') {
      setComputing(false);
      onBelongsGather(msg);
    } else if (msg.type === 'confirmExact') {
      // Exact mode over the consent threshold: ask with the real numbers
      // instead of refusing. The parse cache makes either answer cheap.
      setComputing(false);
      askExactConfirm(msg);
    } else if (msg.type === 'confirmVolume') {
      // The occurrence histogram predicts a quadratic satellite grind —
      // ask before the minutes are spent, with a one-click fix.
      setComputing(false);
      askVolumeConfirm(msg);
    } else if (msg.type === 'needData') {
      // The worker's parse cache missed (e.g. fresh spawn) — resend with
      // full buffers, carrying any bound post-load actions forward.
      workerGen = -1;
      if (boundActions && boundActions.req === msg.id) {
        queuedActions = { overlay: boundActions.overlay, region: boundActions.region };
        boundActions = null;
      }
      if (lastSubmitKind === 'contain' && lastContain) submitContainment(lastContain.window);
      else if (lastSubmitKind === 'belongs' && lastBelongs) submitBelongs(lastBelongs.rec);
      else if (lastKmer) submitKmer(lastKmer.opts, lastKmer.window);
      else setComputing(false);
    } else if (msg.type === 'error') {
      setComputing(false);
      if (!wallRecovery(msg.message)) toast(msg.message, true);
    }
  };
  worker.onerror = (e) => {
    setComputing(false);
    // A dead worker silently swallows every later postMessage — the next
    // submit would spin forever. Respawn now; workerGen resets so the next
    // request resends its buffers.
    worker.terminate();
    spawnWorker();
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
  // A superseded containment request never delivers its grid — un-stamp the
  // view signature so the settle watcher asks again instead of leaving ANI
  // mode drawing segments.
  if (lastSubmitKind === 'contain') containGate.invalidate();
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

/**
 * The one writer of the progress bar: keeps the visual width and the
 * progressbar's announced value in step.
 * @param {number} pct 0..100
 */
function setProgressPct(pct) {
  progressBar.style.width = `${Math.round(pct)}%`;
  $('progress-track').setAttribute('aria-valuenow', String(Math.round(pct)));
}

function cancelCompute() {
  supersede();
  activeReq = -1;
  // Also kills any in-flight reference stream: the generation bump stops
  // stale results applying, and the abort stops the download itself.
  refLoadGen++;
  refAborter?.abort();
  refAborter = null;
  progressEl.hidden = true;
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
  setProgressPct(0);

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
    setProgressPct((sum / parts.length) * 100);
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
        if (!wallRecovery(m.message)) toast(m.message, true);
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
    const message = err instanceof Error ? err.message : String(err);
    if (!wallRecovery(message)) toast(message, true);
    return;
  }
  setComputing(false);
  if (plan.window) {
    onRegionRefined({
      segments: assembled.segments,
      window: plan.window,
      identMin: assembled.identMin,
      saturated: plan.kmerStats?.saturated,
    });
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
    setProgressPct(0);
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
 * Sampling field grammar: 'auto' follows input size; 'off' (or
 * 'exact'/'full') is TRUE full density — every target k-mer indexed and
 * every query position tested, guarded at 128 Mb of target; an optional
 * size raises that ceiling for this machine's RAM ("off 512M" — deep
 * drills, publication figures); a bare number thins the query side only.
 * @returns {{mode: 'auto' | 'off' | number, exactMaxBp?: number}}
 */
function parseSampleField() {
  const t = inSample.value.trim().toLowerCase();
  if (t === '' || t === 'auto') return { mode: 'auto' };
  const m = /^(?:off|exact|full)(?:[:\s]+(.+))?$/.exec(t);
  if (m) {
    if (m[1]) {
      const cap = parseBp(m[1]);
      if (Number.isFinite(cap) && cap > 0) return { mode: 'off', exactMaxBp: Math.round(cap) };
    }
    return { mode: 'off' };
  }
  const v = parseBp(t);
  return { mode: Number.isFinite(v) && v >= 1 ? Math.round(v) : 'auto' };
}

/** @returns {'auto' | 'off' | number} */
function currentSample() {
  return parseSampleField().mode;
}

/**
 * Repeat budget: 'auto' = the standard 60M-anchor budget; "2×"/"4"/… multiply
 * it (clamped to 1..64), loosening the auto repeat cutoff for users who'd
 * rather spend RAM and minutes than sample repeats; 'off' removes the anchor
 * budget entirely — the 16M-segment wall becomes the only volume guard.
 */
function currentBudget() {
  const t = inBudget.value.trim().toLowerCase().replace(/[x×]\s*$/, '');
  if (t === '' || t === 'auto') return 1;
  if (t === 'off' || t === 'none' || t === '∞') return Infinity;
  const v = Number(t);
  return Number.isFinite(v) && v >= 1 ? Math.min(64, v) : 1;
}

/**
 * Occurrence-cap field: 'off'/'none' disables repeat masking entirely
 * (Infinity — the anchor budget remains the volume guard); empty or
 * garbage falls back to the 200 default; numbers are exact.
 */
function currentMaxOcc() {
  const t = inMaxOcc.value.trim().toLowerCase();
  // '0' means "off" in every other length-ish field — an occurrence cap of
  // zero would skip everything, so it means "no masking" here too.
  if (t === 'off' || t === 'none' || t === '∞' || t === '0') return Infinity;
  return Math.max(1, parseLenOff(t, 200) || 200);
}

function matchOpts() {
  const sample = parseSampleField();
  return {
    k: currentK(),
    maxGap: parseLenOff(inGap.value, 64),
    maxOcc: currentMaxOcc(),
    minRunLen: parseLenOff(inMinRun.value, 0),
    sample: sample.mode,
    exactMaxBp: sample.exactMaxBp,
    stride: 1,
    budgetX: currentBudget(),
    maxSegments: wallOverride || undefined,
  };
}

// ---- matching-field canonicalization ---------------------------------------
// The dial readings must be what the next compute will actually use. On
// change, each free-text matching field echoes back the parsed meaning; text
// that would silently fall back to a default instead gets an invalid state
// and one toast. (The region boxes already toast on parse failure — this
// brings the matching fields up to the same standard.)

/** @typedef {{ok: boolean, text?: string, msg?: string}} CanonResult */

/**
 * @param {HTMLInputElement} input
 * @param {(text: string) => CanonResult} canon
 */
function wireCanonicalField(input, canon) {
  input.addEventListener('change', () => {
    const r = canon(input.value);
    if (r.ok) {
      if (r.text !== undefined) input.value = r.text;
      input.removeAttribute('aria-invalid');
    } else {
      input.setAttribute('aria-invalid', 'true');
      toast(r.msg ?? 'Could not parse this field.', true);
    }
  });
  // Typing again withdraws the invalid flag until the next commit.
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
}

/**
 * @param {string} v @param {{off?: boolean, def: string, what: string}} o
 * @returns {CanonResult}
 */
function canonLen(v, o) {
  const t = v.trim().toLowerCase();
  if (t === '') return { ok: true, text: o.def };
  if (t === 'off' || t === '0' || t === 'none') return { ok: true, text: o.off ? 'off' : '0' };
  const n = parseBp(t);
  if (Number.isFinite(n) && n >= 0) return { ok: true, text: String(Math.round(n)) };
  return {
    ok: false,
    msg: `Could not parse ${o.what} “${v.trim()}” — use a length like 64, 1kb, or 2,500${o.off ? ', or off' : ''}.`,
  };
}

wireCanonicalField(inGap, (v) => canonLen(v, { def: '64', what: 'bridge gaps' }));
wireCanonicalField(inMinRun, (v) => canonLen(v, { off: true, def: 'off', what: 'min match length' }));
wireCanonicalField(inMaxOcc, (v) => {
  const t = v.trim().toLowerCase();
  if (t === '') return { ok: true, text: '200' };
  if (t === 'off' || t === 'none' || t === '∞' || t === '0') return { ok: true, text: 'off' };
  const n = parseBp(t);
  if (Number.isFinite(n) && n >= 1) return { ok: true, text: String(Math.round(n)) };
  return { ok: false, msg: `Could not parse occurrence cap “${v.trim()}” — use a count like 200, or off.` };
});
wireCanonicalField(inSample, (v) => {
  const t = v.trim().toLowerCase();
  if (t === '' || t === 'auto') return { ok: true, text: 'auto' };
  const m = /^(?:off|exact|full)(?:[:\s]+(.+))?$/.exec(t);
  if (m) {
    if (!m[1]) return { ok: true, text: 'off' };
    const cap = parseBp(m[1]);
    if (Number.isFinite(cap) && cap > 0) {
      return { ok: true, text: `off ${Math.round(cap / 1e6)}M` };
    }
    return { ok: false, msg: `Could not parse the exact-mode ceiling in “${v.trim()}” — try off 512M.` };
  }
  const n = parseBp(t);
  if (Number.isFinite(n) && n >= 1) return { ok: true, text: String(Math.round(n)) };
  return { ok: false, msg: `Could not parse sampling “${v.trim()}” — use auto, off, off 512M, or an interval like 4.` };
});
wireCanonicalField(inBudget, (v) => {
  const t = v.trim().toLowerCase().replace(/[x×]\s*$/, '');
  if (t === '' || t === 'auto') return { ok: true, text: 'auto' };
  if (t === 'off' || t === 'none' || t === '∞') return { ok: true, text: 'off' };
  const n = Number(t);
  if (Number.isFinite(n) && n >= 1) return { ok: true, text: `${Math.min(64, n)}×` };
  return { ok: false, msg: `Could not parse repeat budget “${v.trim()}” — use auto, a multiplier like 4×, or off.` };
});
wireCanonicalField(inAniTiles, (v) => {
  const t = v.trim().toLowerCase();
  if (t === '' || t === 'auto') return { ok: true, text: 'auto' };
  const n = Number(t);
  if (Number.isFinite(n) && n >= 64) return { ok: true, text: String(Math.min(1024, Math.round(n))) };
  return { ok: false, msg: `Could not parse ANI tiles “${v.trim()}” — use auto or a count from 64 to 1024.` };
});

function displayOpts() {
  return {
    showFwd: chkFwd.checked,
    showRev: chkRev.checked,
    minIdentity: Number(inMinIdent.value),
    minLenBp: parseLenOff(inMinLen.value, 0),
    colorMode: /** @type {0|1|2} */ (Number(selColorMode.value)),
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
  try {
    renderer.setData(data.segments);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
  // Target multiplicity profile → GPU texture, so color-by-multiplicity
  // recolors 16M segments with zero buffer churn.
  renderer.setMultTex(
    data.stats.kmer?.profile ? buildMultiplicityTex(data.stats.kmer.profile) : null,
  );
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
  btnReport.disabled = false;
  btnShare.disabled = false;
  setRefineEnabled(data.source === 'kmer' && !!state.fileTarget);
  panelDetail.hidden = false;
  setMinLen(parseLenOff(inMinLen.value, 0), { skipText: true });
  refineGate.invalidate();
  annoLanes = { x: [], y: [] };
  syncAnnoLayout();
  annoGate.invalidate();
  heatBin = null;
  heatSat = null;
  heatGate.invalidate();
  // Recompute on same-sized data refits to identical bounds — the same view
  // signature. Without this reset the ANI settle watcher would consider the
  // stale grid current and never rebuild (mode says ANI, segments draw).
  containGate.invalidate();
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
    if (v.col === 1 || v.col === 2) selColorMode.value = String(v.col);
    if (v.draw === 'heat' || v.draw === 'ani') {
      selDrawMode.value = v.draw;
      syncAniRow();
    }
    const { pw, ph } = state.sizes;
    state.view.fitRect(v.x0, v.y0, v.x1, v.y1, pw, ph);
    if (v.draw === 'heat') rebuildHeatmap();
    if (v.draw === 'ani') containGate.invalidate(); // containTick requests on settle
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
  if (!window) lastBaseKmer = opts;
  lastSubmitKind = 'kmer';
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
  if (state.computing && lastSubmitKind === 'kmer' && lastKmer && !lastKmer.window) {
    // A PAF dropped during the base compute attaches to that request's
    // result instead of superseding minutes of matching with an overlay
    // parse — same mechanism as a FASTA+PAF drop.
    overlayName = f.name;
    boundActions = { ...(boundActions ?? {}), req: activeReq, overlay: { name: f.name, buf } };
    toast('Aligner overlay queued — it will attach when the compute finishes.');
    return;
  }
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
/** @type {AbortController | null} the in-flight reference stream's plug */
let refAborter = null;

/**
 * Abort any in-flight reference stream and hand out a fresh signal for the
 * next one. Generation checks already stop stale results from APPLYING;
 * this stops the multi-minute download itself — Cancel means cancel, not
 * "keep spending bandwidth on a result nothing will use".
 */
function newRefStreamSignal() {
  refAborter?.abort();
  refAborter = new AbortController();
  return refAborter.signal;
}

/**
 * Provenance for shareable links: the query string that reproduces the
 * current DATA (ref=…, demo=1, target=…), or null when it came from local
 * files no link can carry.
 * @type {string | null}
 */
let shareBase = null;
/** True when the query slot holds a local file a link cannot carry. */
let queryLocal = false;
/** URL the current query slot was fetched from (rides ref share links). */
/** @type {string | null} */
let queryShareUrl = null;
/**
 * The options that produced the current BASE plot (refines overwrite
 * lastKmer with window options — share links must replay the base compute,
 * not the last refine).
 * @type {object | null}
 */
let lastBaseKmer = null;
/** View state from the URL hash, applied to the first plot. */
let pendingView = parseViewHash(location.hash);

/** The user pivoted to new data — stale intents must not fire. */
function newLoadIntent() {
  refLoadGen++;
  refAborter?.abort();
  refAborter = null;
  queuedActions = null;
  shareBase = null;
}

/** @param {{segments: import('./core/types.js').SegmentStore, skipped: number, unknown: number, mismatch?: number, remapped?: number}} msg */
function onOverlay(msg) {
  state.overlay = { segments: msg.segments, name: overlayName };
  renderer.setOverlay(msg.segments);
  rowOverlay.hidden = false;
  chkOverlay.checked = true;
  const parts = [`Aligner overlay: ${formatCount(msg.segments.count)} calls drawn over the plot.`];
  if (msg.remapped) {
    parts.push(`${formatInt(msg.remapped)} full-sequence calls placed by their genomic coordinates.`);
  }
  if (msg.unknown > 0) parts.push(`${formatInt(msg.unknown)} lines named sequences not on these axes (dropped).`);
  if (msg.mismatch) {
    parts.push(
      `${formatInt(msg.mismatch)} lines carried coordinates for a different sequence extent — ` +
        'wrong assembly or window? (dropped, not misplaced).',
    );
  }
  if (msg.skipped > 0) parts.push(`${formatInt(msg.skipped)} malformed lines skipped.`);
  toast(parts.join(' '));
  updateLegend();
  markDirty();
  // An ANI grid may have been superseded by this overlay parse — let the
  // settle watcher re-request it.
  if (aniMode()) containGate.invalidate();
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
  annoGate.invalidate();
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
 * Resolve one region-list expression to concrete 0-based windows (arms via
 * the cytoband track, bare names to whole sequences). Returns null after
 * toasting on any problem, or when the load generation moved on.
 * @param {import('./refs.js').ReferenceGenome} ref
 * @param {string} listText
 * @param {number} gen
 * @returns {Promise<{chrom: string, start0: number, end0: number, name?: string}[] | null>}
 */
async function resolveRegions(ref, listText, gen) {
  const exprs = splitRegionList(listText);
  /** @type {NonNullable<ReturnType<typeof parseBrowserRegion>>[]} */
  const parsedList = [];
  for (const e of exprs) {
    const p = parseBrowserRegion(e);
    if (!p) {
      toast(`Could not parse region “${e}” — try chrX:57.8M-60.7M, chr13p, or a comma/;-separated list.`, true);
      return null;
    }
    if (p.arm && p.start1 !== null) {
      toast(`Use either an arm (${p.chrom}${p.arm}) or coordinates — not both.`, true);
      return null;
    }
    parsedList.push(p);
  }
  if (parsedList.length === 0) return null;
  const tb = getTwoBit(ref);
  /** @type {{chrom: string, start0: number, end0: number, name?: string}[]} */
  const regions = [];
  for (const p of parsedList) {
    const meta = await tb.seqMeta(p.chrom).catch(async (err) => {
      const names = await tb.names().catch(() => []);
      throw new Error(
        (err instanceof Error ? err.message : String(err)) +
          (names.length ? ` Available: ${names.slice(0, 8).join(', ')}…` : ''),
      );
    });
    if (gen !== refLoadGen) return null;
    if (p.arm) {
      const [a0, a1] = await armRange(ref, p.chrom, p.arm, meta.dnaSize);
      if (a1 <= a0) {
        toast(`${p.chrom}${p.arm} is empty in this cytoband set.`, true);
        return null;
      }
      regions.push({ chrom: p.chrom, start0: a0, end0: a1, name: `${p.chrom}${p.arm}` });
    } else {
      const start0 = p.start1 !== null ? p.start1 - 1 : 0;
      const end0 = Math.min(p.end1 ?? meta.dnaSize, meta.dnaSize);
      if (end0 - start0 <= 0) {
        toast(`${p.chrom} is only ${formatBp(meta.dnaSize)} long.`, true);
        return null;
      }
      regions.push({ chrom: p.chrom, start0, end0 });
    }
  }
  return regions;
}

/** @param {{chrom: string, start0: number, end0: number, name?: string}[]} regions */
function regionsLabel(regions) {
  if (regions.length > 1) return `${regions.length} regions`;
  if (regions[0].name) return regions[0].name;
  return `${regions[0].chrom}:${formatInt(regions[0].start0 + 1)}-${formatInt(regions[0].end0)}`;
}

/**
 * Fetch a reference region (browser coordinates, 1-based) and install it as
 * the target: self-plot when no query FASTA is loaded, query-vs-reference
 * otherwise. `chr21p vs chr22p` streams the left side as the target axis and
 * the right side as the query axis — the direct cross-comparison, no quad
 * tiles. The synthesized FASTA carries an `@offset=` token so every
 * coordinate the app shows for it is a true genomic coordinate.
 * @param {string} text
 */
async function loadRefRegion(text) {
  const ref = currentRef();
  if (!ref) return;
  const cross = splitCrossSpec(text);
  // Anything the user does after this (own FASTA, another selection, Clear)
  // bumps the generation; a slow fetch must then discard itself instead of
  // clobbering the newer data.
  const gen = ++refLoadGen;
  const signal = newRefStreamSignal();
  try {
    const tRegions = await resolveRegions(ref, cross.target, gen);
    if (!tRegions || gen !== refLoadGen) return;
    const qRegions = cross.query ? await resolveRegions(ref, cross.query, gen) : null;
    if (cross.query && !qRegions) return;
    if (gen !== refLoadGen) return;
    const sum = (/** @type {{start0:number,end0:number}[]} */ rs) =>
      rs.reduce((a, r) => a + (r.end0 - r.start0), 0);
    const total = sum(tRegions) + (qRegions ? sum(qRegions) : 0);
    if (total > 1e9) {
      toast('Regions too large — 1 Gb max combined (the engine addresses 32-bit coordinates).', true);
      return;
    }
    // Big is allowed, informed: past 300 Mb combined, state the real costs
    // and ask — the chr1-vs-chr2 class of comparison is one click, not a
    // refusal.
    if (total > 300e6 && !(await askStreamConfirm(total))) return;
    if (gen !== refLoadGen) return;
    const tLabel = regionsLabel(tRegions);
    const label = qRegions ? `${tLabel} vs ${regionsLabel(qRegions)}` : tLabel;
    toast(`Fetching ${label} (${formatBp(total)}) from ${ref.label}…`);
    // Whole-chromosome streams take minutes: show live MB progress through
    // the standard progress chrome (Cancel bumps the load generation).
    const tBytes = Math.ceil(sum(tRegions) / 4);
    const qBytes = qRegions ? Math.ceil(sum(qRegions) / 4) : 0;
    const grandBytes = tBytes + qBytes;
    const showProgress = total > 32e6;
    const streamTick = (/** @type {number} */ done) => {
      if (gen !== refLoadGen) return;
      progressLabel.textContent =
        `Streaming ${label} — ${Math.round(done / 1e6)} / ${Math.round(grandBytes / 1e6)} MB`;
      setProgressPct((done / Math.max(1, grandBytes)) * 100);
    };
    if (showProgress) {
      progressEl.hidden = false;
      streamTick(0);
    }
    try {
      const tBuf = await streamRefRegions(ref, tRegions, showProgress ? streamTick : undefined, signal);
      if (gen !== refLoadGen) return;
      if (qRegions) {
        const qBuf = await streamRefRegions(
          ref, qRegions,
          showProgress ? (d) => streamTick(tBytes + d) : undefined,
          signal,
        );
        if (gen !== refLoadGen) return;
        // Query first, target second, same tick: the debounced autocompute
        // runs exactly once, on the pair (the demo loads the same way).
        queryLocal = false; // the refregion text itself reproduces this query
        queryShareUrl = null;
        setFasta('query', { name: `${regionsLabel(qRegions)} · ${ref.label}`, buf: qBuf.buffer });
        setFasta('target', { name: `${tLabel} · ${ref.label}`, buf: tBuf.buffer });
      } else {
        setFasta('target', { name: `${tLabel} · ${ref.label}`, buf: tBuf.buffer });
      }
    } finally {
      if (showProgress && !state.computing) progressEl.hidden = true;
    }
    const sp = new URLSearchParams({ ref: ref.id, refregion: text });
    // A URL-loaded query survives a reference (re)load — keep it in the link
    // so the recipient gets the same query-vs-reference plot, not a self-plot.
    if (!cross.query && state.fileQuery && queryShareUrl) sp.set('query', queryShareUrl);
    shareBase = sp.toString();
  } catch (err) {
    // A cancelled/superseded load bumped the generation — its abort error
    // is the intended outcome, not news for a toast.
    if (gen !== refLoadGen) return;
    toast(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * Consent card for very large reference streams: the honest costs (transfer
 * is total/4 — 2bit is 2 bits/base — plus several× that in RAM once parsed
 * and matched), one click to proceed.
 * @param {number} totalBp
 * @returns {Promise<boolean>}
 */
function askStreamConfirm(totalBp) {
  return new Promise((resolve) => {
    const mb = Math.round(totalBp / 4 / 1e6);
    const gb = ((totalBp * 3) / 1e9).toFixed(1);
    /** @param {boolean} ok */
    const done = (ok) => {
      setConfirmDismiss(null); // settled by a button, not a dismissal
      closeConfirm();
      resolve(ok);
    };
    confirmCard(
      'Large reference stream',
      `${formatBp(totalBp)} of sequence ≈ a <b>${mb} MB</b> download from UCSC and roughly ` +
        `<b>${gb} GB</b> of RAM once parsed and matched (the compute itself auto-samples at ` +
        `this scale). Chromosome-vs-chromosome comparisons are minutes, not seconds.`,
      [
        { id: 'cs-go', label: 'Stream it', primary: true, onClick: () => done(true) },
        { id: 'cs-no', label: 'Cancel', onClick: () => done(false) },
      ],
    );
    // Escape, backdrop click, or a replacing dialog all read as "cancel".
    setConfirmDismiss(() => resolve(false));
  });
}

/** @type {Map<string, {pEnd: number, qStart: number}>} */
const armBounds = new Map();

/**
 * Cytogenetic arm range from the reference's streamed cytoband track:
 * p = [0, end of the last p-band), q = [start of the first q-band, size).
 * @param {import('./refs.js').ReferenceGenome} ref
 * @param {string} chrom @param {'p'|'q'} arm @param {number} dnaSize
 * @returns {Promise<[number, number]>}
 */
async function armRange(ref, chrom, arm, dnaSize) {
  if (!ref.cytoband) {
    throw new Error(`Arm coordinates (${chrom}${arm}) need a cytoband track — not available for ${ref.label} yet.`);
  }
  const key = `${ref.id}|${chrom}`;
  let b = armBounds.get(key);
  if (!b) {
    const bands = await getBigBed(ref.cytoband).query(chrom, 0, dnaSize);
    if (bands.length === 0) throw new Error(`No cytobands for ${chrom} in ${ref.label}.`);
    let pEnd = 0;
    let qStart = dnaSize;
    for (const band of bands) {
      if (band.name.startsWith('p')) pEnd = Math.max(pEnd, band.end);
      if (band.name.startsWith('q')) qStart = Math.min(qStart, band.start);
    }
    b = { pEnd, qStart };
    armBounds.set(key, b);
  }
  return arm === 'p' ? [0, b.pEnd] : [b.qStart, dnaSize];
}

/**
 * Stream reference windows (0-based half-open) and wrap them as one FASTA.
 * Record labels and @offset tokens derive from the same numbers, so the
 * displayed coordinates can never drift from what was fetched.
 * @param {import('./refs.js').ReferenceGenome} ref
 * @param {{chrom: string, start0: number, end0: number, name?: string}[]} regions
 * @param {(doneBytes: number, totalBytes: number) => void} [onProgress]
 * @param {AbortSignal} [signal] cancels the packed-DNA downloads mid-flight
 */
async function streamRefRegions(ref, regions, onProgress, signal) {
  const tb = getTwoBit(ref);
  // 2bit is 2 bits/base: transfer ≈ span/4 per region; aggregate progress
  // across the parallel fetches so whole-chromosome streams stay visibly
  // alive for their minutes of download.
  const doneBy = new Array(regions.length).fill(0);
  const totalEst = regions.reduce((a, r) => a + Math.ceil((r.end0 - r.start0) / 4), 0);
  const parts = await Promise.all(
    regions.map((r, i) =>
      tb.fetchRegion(
        r.chrom,
        r.start0,
        r.end0,
        (d) => {
          doneBy[i] = d;
          if (onProgress) onProgress(doneBy.reduce((a, b) => a + b, 0), totalEst);
        },
        signal,
      ),
    ),
  );
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

// Selection UI reflects immediately; the network side debounces — keyboard
// browsing fires change per arrow step on some platforms, and each default
// region is a real UCSC stream (generation guards make the spam harmless,
// but not free).
/** @type {ReturnType<typeof setTimeout> | undefined} */
let refLoadTimer;
selRef.addEventListener('change', () => {
  applyRefSelection(false);
  clearTimeout(refLoadTimer);
  refLoadTimer = setTimeout(() => {
    const ref = currentRef();
    if (ref) void loadRefRegion(ref.defaultRegion);
  }, 350);
});
selRefPreset.addEventListener('change', () => {
  inRefRegion.value = selRefPreset.value;
  clearTimeout(refLoadTimer);
  refLoadTimer = setTimeout(() => void loadRefRegion(selRefPreset.value), 350);
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
// Lane building (name resolution, tile cache, @offset math) lives in
// app/annotations.js, unit-tested against a fake track source.
const laneBuilder = new LaneBuilder((url) => getBigBed(url));
/** @type {{x: import('./render/axes.js').AnnoLane[], y: import('./render/axes.js').AnnoLane[]}} */
let annoLanes = { x: [], y: [] };
let annoBusy = false;
let annoLaneCounts = { x: 0, y: 0 };

function activeTracks() {
  return annoGenome().tracks.filter((t) => annoEnabled.get(t.id) ?? t.on);
}

/** The k-mer multiplicity lane: on, and this plot's index shipped a profile. */
function activeMult() {
  return chkMult.checked && !!state.data?.stats.kmer?.profile;
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
  const multOn = activeMult();
  if (tracks.length === 0 && !multOn) {
    annoLanes = { x: [], y: [] };
    syncAnnoLayout();
    markDirty();
    return;
  }
  const { pw, ph } = state.sizes;
  const b = state.view.bounds(pw, ph);
  annoBusy = true;
  try {
    const [lx, ly] =
      tracks.length > 0
        ? await Promise.all([
            laneBuilder.buildAxisLanes(d.target, Math.max(0, b.x0), Math.min(d.target.total, b.x1), tracks),
            laneBuilder.buildAxisLanes(d.query, Math.max(0, b.y0), Math.min(d.query.total, b.y1), tracks),
          ])
        : [null, null];
    if (state.data === d) {
      const x = lx ?? [];
      const y = ly ?? [];
      const km = d.stats.kmer;
      if (multOn && km?.profile) {
        // The profile describes the target concatenation; on self-plots the
        // query axis is the same space, so it earns the mirror lane.
        const cm = buildColormap(mode);
        const stride = km.stride ?? 1;
        const mx = multLane(km.profile, stride, Math.max(0, b.x0), Math.min(d.target.total, b.x1), pw, cm.multRgb);
        if (mx) x.push(mx);
        if (!state.fileQuery) {
          const my = multLane(km.profile, stride, Math.max(0, b.y0), Math.min(d.query.total, b.y1), ph, cm.multRgb);
          if (my) y.push(my);
        }
      }
      annoLanes = { x, y };
      /** @type {any} */ (globalThis).__dotdotAnno = annoLanes; // debug/automation handle
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
/** @type {{lo: number, hi: number}} the ramp's stretched identity range */
let heatRange = { lo: 0, hi: 1 };
let heatKickPending = false;
/** @type {import('./render/heatmap.js').SatMasks | null} saturation masks of the current bin */
let heatSat = null;

function heatMode() {
  return selDrawMode.value === 'heat';
}

/** ANI heatmap: tile-pair identity by multiset containment — no cap, no trap. */
function aniMode() {
  return selDrawMode.value === 'ani';
}

/** Either image-underlay mode: base segments hide, heatCanvas draws. */
function heatLike() {
  return heatMode() || aniMode();
}

/** Is this world point inside the current bin's saturation hatch region? */
/** @param {number} wx @param {number} wy */
function heatSatAt(wx, wy) {
  if (!heatBin || !heatSat) return false;
  const b = heatBin;
  const cx = Math.floor(((wx - b.x0) / Math.max(b.x1 - b.x0, 1e-9)) * b.nx);
  const cy = Math.floor(((wy - b.y0) / Math.max(b.y1 - b.y0, 1e-9)) * b.ny);
  if (cx < 0 || cx >= b.nx || cy < 0 || cy >= b.ny) return false;
  return heatSat.maskX[cx] === 1 && (heatSat.maskY === null || heatSat.maskY[cy] === 1);
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
  // Saturation hatch: empty cells inside occurrence-capped target regions
  // mean "not searched", never "not similar". On self-plots the same
  // intervals apply to the query axis, and only the repeat×repeat blocks
  // (both axes capped) are truly unsearched; on cross-plots the target
  // column is the honest necessary condition.
  const sat = d.stats.kmer?.saturated;
  heatSat =
    sat && sat.length > 0
      ? {
          maskX: buildSatMask(sat, b.x0, b.x1, nx),
          maskY: state.fileQuery ? null : buildSatMask(sat, b.y0, b.y1, ny),
          ...(mode === 'dark' ? { r: 138, g: 145, b: 160, a: 150 } : { r: 122, g: 128, b: 142, a: 165 }),
        }
      : null;
  const img = paintHeatmap(bin, cm.data, 0, heatRange.lo, heatRange.hi, heatSat);
  if (!heatCanvas) heatCanvas = document.createElement('canvas');
  heatCanvas.width = nx;
  heatCanvas.height = ny;
  /** @type {CanvasRenderingContext2D} */ (heatCanvas.getContext('2d')).putImageData(img, 0, 0);
  heatBin = bin;
  // Direct calls (mode change, strand toggle, pending view) count as the
  // settle rebin for the current view — without the stamp the next tick
  // would rebin the same millions of segments a second time.
  heatGate.stamp();
  updateLegend();
  markDirty();
}

/**
 * Repaint the existing heat/ANI bin with the current theme's colormap.
 * The bin grid itself is theme-independent — only the paint changes — so a
 * theme flip never needs a rebin or a worker round-trip.
 */
function repaintHeatCanvas() {
  if (!heatBin || !heatCanvas || !heatLike()) return;
  const cm = buildColormap(mode);
  if (heatSat) {
    Object.assign(
      heatSat,
      mode === 'dark' ? { r: 138, g: 145, b: 160, a: 150 } : { r: 122, g: 128, b: 142, a: 165 },
    );
  }
  const img = paintHeatmap(heatBin, aniMode() ? cm.aniData : cm.data, 0, heatRange.lo, heatRange.hi, heatSat);
  /** @type {CanvasRenderingContext2D} */ (heatCanvas.getContext('2d')).putImageData(img, 0, 0);
  markDirty();
}

/** Settle watcher for heatmap rebins. @param {number} now */
function heatmapTick(now) {
  if (!heatMode() || !state.data) return;
  // Small plots rebin almost immediately; big ones wait for a firmer rest.
  const settleMs = state.data.segments.count < 1_500_000 ? 120 : 250;
  if (!heatGate.due(now, settleMs)) return;
  heatGate.stamp();
  rebuildHeatmap();
}

/** The ANI-tiles dial only applies to the ANI heatmap — hide it elsewhere. */
function syncAniRow() {
  $('row-anitiles').hidden = !aniMode();
}

selDrawMode.addEventListener('change', () => {
  syncAniRow();
  if (heatMode()) {
    rebuildHeatmap();
  } else if (aniMode()) {
    if (state.data && state.data.source !== 'kmer') {
      toast('The ANI heatmap needs an alignment-free plot (FASTA inputs).');
      selDrawMode.value = 'seg';
    } else {
      heatBin = null;
      heatSat = null;
      containGate.invalidate(); // request on next settle tick
    }
  } else {
    heatBin = null;
    heatSat = null;
  }
  setHover(null, null);
  updateLegend();
  markDirty();
});

// ---- ANI (containment) heatmap: settle watcher + request lifecycle --------

/** @param {number} now */
function containTick(now) {
  if (!aniMode() || !state.data || !state.view || state.computing) return;
  if (state.data.source !== 'kmer' || !state.fileTarget) return;
  if (!containGate.due(now, 500)) return;
  containGate.stamp();
  const { pw, ph } = state.sizes;
  const b = state.view.bounds(pw, ph);
  const w = {
    tx0: Math.max(0, Math.floor(b.x0)),
    tx1: Math.min(state.data.target.total, Math.ceil(b.x1)),
    qy0: Math.max(0, Math.floor(b.y0)),
    qy1: Math.min(state.data.query.total, Math.ceil(b.y1)),
  };
  if (w.tx1 - w.tx0 < 100 || w.qy1 - w.qy0 < 100) return;
  submitContainment(w);
}

/**
 * ANI tile-count field: 'auto' sizes to the display and a work budget; an
 * explicit number (to 1024) is honored outright — export-grade, user-paid.
 * @returns {number} 0 = auto
 */
function currentAniTiles() {
  const t = inAniTiles.value.trim().toLowerCase();
  if (t === '' || t === 'auto') return 0;
  const v = Number(t);
  return Number.isFinite(v) && v >= 64 ? Math.min(1024, Math.round(v)) : 0;
}

/** @param {{tx0:number,tx1:number,qy0:number,qy1:number}} window */
function submitContainment(window) {
  if (!state.fileTarget) return;
  lastContain = { window };
  lastSubmitKind = 'contain';
  const sendData = workerGen !== dataGen;
  const forceN = currentAniTiles();
  submit({
    type: 'containment',
    gen: dataGen,
    // maxN: tiles beyond ~1 per 1.5 css px out-resolve the display (auto).
    opts: { k: currentK(), maxN: Math.round(state.sizes.pw / 1.5), forceN: forceN || undefined },
    window,
    target: sendData ? state.fileTarget.bufs : null,
    query: sendData ? (state.fileQuery ? state.fileQuery.bufs : null) : null,
  });
  workerGen = dataGen;
}

/**
 * @param {{grid: Float32Array, nx: number, ny: number, window: {tx0:number,tx1:number,qy0:number,qy1:number}, elapsedMs: number}} msg
 */
function onContainResult(msg) {
  if (!state.data || !aniMode()) return;
  const w = msg.window;
  heatBin = { grid: msg.grid, nx: msg.nx, ny: msg.ny, x0: w.tx0, x1: w.tx1, y0: w.qy0, y1: w.qy1 };
  heatSat = null; // nothing was skipped — that is the point
  heatRange = binStretch(heatBin);
  const cm = buildColormap(mode);
  // The ANI ramp is multi-hue (viridis anchors): satellite windows live in a
  // narrow high-identity band, and hue separates 97/99.5/100% where a
  // single-hue ramp compresses them.
  const img = paintHeatmap(heatBin, cm.aniData, 0, heatRange.lo, heatRange.hi);
  if (!heatCanvas) heatCanvas = document.createElement('canvas');
  heatCanvas.width = msg.nx;
  heatCanvas.height = msg.ny;
  /** @type {CanvasRenderingContext2D} */ (heatCanvas.getContext('2d')).putImageData(img, 0, 0);
  updateLegend();
  markDirty();
}

/** Settle watcher for annotation fetches (rides the frame loop). @param {number} now */
function annotationTick(now) {
  if (!state.data || annoBusy) return;
  if (activeTracks().length === 0 && !activeMult()) {
    if (annoLanes.x.length || annoLanes.y.length) {
      annoLanes = { x: [], y: [] };
      syncAnnoLayout();
      markDirty();
    }
    return;
  }
  if (!annoGate.due(now, 400)) return;
  annoGate.stamp();
  void refreshAnnotations();
}

chkMult.addEventListener('change', () => {
  annoGate.invalidate();
});
inAniTiles.addEventListener('change', () => {
  containGate.invalidate(); // recompute on next settle when in ANI mode
});

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
      annoGate.invalidate();
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
      // interchangeable with the committed fallback (same records, names,
      // and @offset coordinates; only line wrapping differs).
      const buf = await streamRefRegions(
        REFERENCES[0],
        [
          { chrom: 'chr17', start0: 18_000_000, end0: 19_600_000, name: 'chr17_17p11.2' },
          { chrom: 'chr17', start0: 10_600_000, end0: 11_200_000, name: 'chr17_ROI10.9' },
        ],
        undefined,
        newRefStreamSignal(),
      );
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
    queryLocal = false; // demo=1 reproduces both slots
    queryShareUrl = null;
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
  closeConfirm(); // an open consent card was asking about the OLD data
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
    // No in-flight guard: submit() supersedes safely, and skipping here
    // would leave the fresh data chips describing a plot that never
    // computes (the old result still passes the id gate and renders).
    if (state.fileTarget) computeKmer();
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
  // A PAF-only drop is an overlay (or standalone plot) — it must not wipe
  // the share provenance and queued intents of the data it lands on.
  if (fastas.length > 0) newLoadIntent();
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
    setLocalQuery({
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
      else if (!state.fileQuery) setLocalQuery(f);
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

/** Install a locally picked/dropped query file (links cannot carry it). */
function setLocalQuery(/** @type {SlotFile} */ f) {
  queryLocal = true;
  queryShareUrl = null;
  setFasta('query', f);
}

wireFileInput('file-target', (f) => {
  newLoadIntent();
  setFasta('target', f);
});
wireFileInput('file-query', (f) => {
  newLoadIntent();
  setLocalQuery(f);
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
  autoCollapseStats(pw, ph);
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
  containTick(performance.now());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @param {number} dpr */
function draw(dpr) {
  const { cssW, cssH, pw, ph } = state.sizes;
  const d = displayOpts();

  const heat = heatLike() && heatBin && heatCanvas;
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
        if (aniMode()) containGate.invalidate(); // fresh containment on next settle
        else rebuildHeatmap();
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
      widthPx: d.widthPx,
      minLenPx: d.minLenPx,
      alpha: 0.85,
      colorMode: d.colorMode,
      totalX: state.data.target.total,
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
Object.defineProperty(globalThis, '__dotdotContainTick', {
  value: (/** @type {number} */ now) => containTick(now),
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
  // Only the primary button pans — a right-click must not latch `panning`
  // (its pointerup never arrives once the context menu opens).
  if (e.button !== 0) return;
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
    // Hit-testing shares the axes module's lane geometry constants — the
    // hardcoded copies here once drifted a tooltip away from its lane.
    if (p.y > ph + 6 && p.x >= 0 && p.x <= pw && annoLanes.x.length > 0) {
      const li = Math.floor((p.y - ph - LANE_X0) / LANE_H);
      if (li >= 0 && li < annoLanes.x.length) {
        lane = annoLanes.x[li];
        world = state.view.pxToWorldX(p.x, pw);
        cat = state.data.target;
      }
    } else if (p.x < 0 && p.y >= 0 && p.y <= ph && annoLanes.y.length > 0) {
      const cssX = p.x + LAYOUT.l;
      const li = Math.floor((cssX - LANE_Y0) / LANE_H);
      if (cssX >= LANE_Y0 && li >= 0 && li < annoLanes.y.length) {
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

// A system gesture (touch scroll takeover, palm rejection) can cancel the
// pointer mid-drag — without this, `panning` stays latched and the next
// bare hover pans the view with no button held.
overlay.addEventListener('pointercancel', (e) => {
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
  if (heatLike()) {
    // Cell readout instead of segment picking.
    setHover(null, null);
    if (heatBin) {
      const wx = state.view.pxToWorldX(p.x, pw);
      const wy = state.view.pxToWorldY(p.y, ph);
      const v = heatAt(heatBin, wx, wy);
      if (v > 0) {
        hoverCard.className = '';
        hoverCard.textContent = aniMode()
          ? `tile k-mer ANI ~${(v * 100).toFixed(1)}% (containment; ramp ${(heatRange.lo * 100).toFixed(1)}–${(heatRange.hi * 100).toFixed(1)}%)`
          : `tile anchor identity ≥ ${(v * 100).toFixed(1)}% (ramp ${(heatRange.lo * 100).toFixed(1)}–${(heatRange.hi * 100).toFixed(1)}%)`;
      } else if (heatSatAt(wx, wy)) {
        hoverCard.className = '';
        hoverCard.textContent =
          'capped repeats — k-mers here exceed the repeat cutoff, matches were not enumerated. ' +
          'Refine the view or raise the repeat budget.';
      } else {
        hoverCard.className = 'empty';
        hoverCard.textContent = aniMode() ? 'no shared k-mers' : 'empty tile';
      }
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
  // Name the metric honestly: k-mer plots report anchor identity (exact-run
  // coverage), PAF rows carry the aligner's own identity.
  const identLabel = data.source === 'kmer' ? 'anchor identity' : 'identity';
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
    `<span class="t-ident">${ident}% ${identLabel}</span></div>`
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
  // Only typing contexts swallow shortcuts — a residually-focused button or
  // checkbox (just clicked) must not eat R/F/G/[/]. A focused slider keeps
  // its own arrow/± keys; everything else passes through.
  if (t && t.closest('select, textarea')) return;
  if (t instanceof HTMLInputElement) {
    const nonTyping = /^(?:checkbox|radio|range|button|file|submit|reset)$/.test(t.type);
    if (!nonTyping) return;
    if (
      t.type === 'range' &&
      (e.key.startsWith('Arrow') || e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')
    ) {
      return;
    }
  }
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
      // Programmatic .checked fires no change event — dispatch it so the
      // heatmap rebin (and anything else on the listener) sees the toggle.
      chkFwd.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    case '2':
      chkRev.checked = !chkRev.checked;
      chkRev.dispatchEvent(new Event('change', { bubbles: true }));
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
  const label = v <= state.identLo ? 'off' : `${(v * 100).toFixed(1)}%`;
  outMinIdent.textContent = label;
  inMinIdent.setAttribute('aria-valuetext', label);
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
  refineGate.stamp(); // a window refined by hand needn't auto-refine again
  // Debug/automation stamp (globalThis.__dotdot.lastRefine).
  /** @type {any} */ (state).lastRefine = { auto, window: { tx0, tx1, qy0, qy1 } };
  // Full density plus a raised repeat budget: an explicit refine means
  // "spend the time here" — at full fit this deepens the WHOLE plot
  // (satellite cores especially), not just re-derives it. A user-raised
  // budget only ever raises it further, and a user in exact mode stays
  // exact (window permitting).
  const sample = currentSample() === 'off' ? 'off' : 1;
  submitKmer({ ...matchOpts(), sample, budgetX: Math.max(4, currentBudget()) }, { tx0, tx1, qy0, qy1 });
}

// ---- auto-refine: settle-watcher over the view -----------------------------
// With "auto" on, resting ~1 s at a meaningfully zoomed view refines that
// window by itself — the zoom → refine loop with the second step removed.
// supersede() keeps rapid navigation cheap; the signature guard keeps any
// window from refining twice.
let refineQuiet = false;

/** @param {number} now */
function autoRefineTick(now) {
  if (!state.view || !state.data) return;
  const { pw, ph } = state.sizes;
  const b = state.view.bounds(pw, ph);
  const sig = `${Math.round(b.x0)},${Math.round(b.x1)},${Math.round(b.y0)},${Math.round(b.y1)}`;
  if (settle.update(sig, now)) return;
  if (!chkAutoRefine.checked || state.computing) return;
  // Never kick off a compute under an open consent card — the user is being
  // asked a question about the job that is already pending.
  if (!confirmPop.hidden) return;
  if (!refineGate.due(now, 900)) return;
  if (state.data.source !== 'kmer' || !state.fileTarget) return;
  const txSpan = Math.min(state.data.target.total, b.x1) - Math.max(0, b.x0);
  const qySpan = Math.min(state.data.query.total, b.y1) - Math.max(0, b.y0);
  const areaFrac = (txSpan * qySpan) / (state.data.target.total * state.data.query.total);
  if (txSpan < 100 || qySpan < 100 || areaFrac > 0.25) return;
  refineView(true);
}

/**
 * @param {{segments: import('./core/types.js').SegmentStore, window: {tx0:number,tx1:number,qy0:number,qy1:number}, identMin: number, saturated?: Float64Array}} msg
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
  if (total > Math.max(20_000_000, (wallOverride || 16_000_000) * 1.25)) {
    toast('Refining this window would exceed the segment wall — narrow the view or raise min match length.', true);
    return;
  }
  const merged = allocSegments(total);
  for (let j = 0; j < keep.length; j++) copySegmentRow(merged, j, s, keep[j]);
  blitSegments(merged, keep.length, ns);

  d.segments = merged;
  d.stats.merged = true; // segments/s from the base compute no longer applies
  try {
    renderer.setData(merged);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
  }
  state.grid = null;
  state.hoverIndex = null;
  heatGate.invalidate(); // refined data: rebin on next settle
  // The refine's looser repeat cutoff may have de-saturated (or re-drawn)
  // parts of the window — splice its saturation picture into the whole-plot
  // one so the hatch stays truthful.
  if (d.stats.kmer && msg.saturated) {
    d.stats.kmer.saturated = spliceIntervals(d.stats.kmer.saturated, w.tx0, w.tx1, msg.saturated);
  }
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
function doClearAll() {
  // Kill in-flight work first: without this, a compute finishing later
  // passes the id gate and repopulates the app the UI says is empty (and
  // the worker keeps holding its parse cache).
  worker.terminate();
  spawnWorker();
  stopPool();
  heatBin = null;
  heatSat = null;
  settle.reset(); // restarts the settle bus AND invalidates every gate —
  lastJump = { expr: '', idx: -1 }; // the next data inherits no signatures
  clearTimeout(autoTimer);
  closeConfirm();
  activeReq = -1;
  setComputing(false);
  newLoadIntent();
  boundActions = null;
  lastKmer = null;
  lastBaseKmer = null;
  lastContain = null;
  lastBelongs = null;
  belongsUi = { gen: -1, k: 0, matrix: null, gathers: new Map(), sel: -1, pending: -1, win: '', view: 'card', cells: 'shared' };
  btnBelongs.hidden = true;
  queryLocal = false;
  queryShareUrl = null;
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
  segScan = { ref: null, fwd: 0, rev: 0, bpFwd: 0, bpRev: 0 };
  statsPopCache = { ref: null, mode: '', html: '' };
  btnCompute.disabled = true;
  btnReport.disabled = true;
  btnCompute.textContent = 'Compute dot plot';
  legendEl.className = 'empty';
  legendEl.textContent = 'no data';
  statsEl.innerHTML = '';
  markDirty();
}

$('btn-clear').addEventListener('click', () => {
  // Destroying a loaded plot (and local file selections there is no way to
  // re-load except re-picking) deserves the same consent treatment as every
  // other irreversible spend in this app. An already-empty app just clears.
  if (!state.data && !state.fileTarget && !state.overlay) {
    doClearAll();
    return;
  }
  confirmCard(
    'Clear everything?',
    `Unloads the plot, both FASTA slots, and any aligner overlay. Locally picked files must ` +
      `be picked again; computes re-run from scratch.`,
    [
      {
        id: 'cc-go',
        label: 'Clear the plot and unload files',
        primary: true,
        onClick: () => {
          closeConfirm();
          doClearAll();
        },
      },
      { id: 'cc-no', label: 'Keep everything', onClick: closeConfirm },
    ],
  );
});

// ---- Report export: one PNG with the plot, belongs grids, gather, charts --

/** Resolve CSS var() tokens in an SVG string to literal colors. @param {string} svg */
function resolveSvgVars(svg) {
  const cs = getComputedStyle(document.documentElement);
  return svg.replace(/var\((--[a-z0-9-]+)\)/gi, (_, n) => cs.getPropertyValue(n).trim() || '#888888');
}

async function exportReport() {
  const d = state.data;
  if (!d) return;
  btnReport.disabled = true;
  try {
    // Full-resolution frame of the current view, same stash dance as capture.
    const stashCursor = state.cursor;
    const stashFps = state.fpsOn;
    state.cursor = null;
    state.fpsOn = false;
    draw(2);
    const plot = compositeCanvases({ underlay, glCanvas: glcanvas, overlay, dpr: 2 });
    state.cursor = stashCursor;
    state.fpsOn = stashFps;
    draw(window.devicePixelRatio || 1);

    const rootCs = getComputedStyle(document.documentElement);
    /** @param {string} n @param {string} fb */
    const tok = (n, fb) => rootCs.getPropertyValue(n).trim() || fb;
    const theme = {
      bg: tok('--page', '#0b0d10'),
      panel: tok('--panel', '#14171c'),
      ink: tok('--ink', '#e8eaee'),
      ink2: tok('--ink-2', '#c6cad2'),
      muted: tok('--muted', '#8a909b'),
      border: tok('--border', '#2a2f37'),
      family: getComputedStyle(document.body).fontFamily.replace(/"/g, "'"),
    };

    // Belongs grids ride along when the matrix is fresh for this data.
    /** @type {import('./export/report.js').ReportSpec['matrix']} */
    let matrix = null;
    const bm = belongsUi.gen === dataGen ? belongsUi.matrix : null;
    if (bm) {
      const nRb = bm.nR;
      const labels = [];
      for (let i = 0; i < nRb; i++) labels.push(belongsLabel(i, bm.nRecT));
      /** @param {Float64Array} arr @param {number} i @param {number} j */
      const sym = (arr, i, j) => (i < j ? arr[i * nRb + j] : arr[j * nRb + i]);
      matrix = {
        labels,
        aniHex,
        grids: [
          {
            title: 'shared content — row ⊂ col',
            valueOf: (r, c) => (bm.tot[r] > 0 ? sym(bm.shared, r, c) / bm.tot[r] : 0),
          },
          {
            title: 'exclusive to pair',
            valueOf: (r, c) => (bm.tot[r] > 0 ? sym(bm.exclusive, r, c) / bm.tot[r] : 0),
          },
          {
            title: 'unique content',
            valueOf: (r, c) => (bm.uniqTot[r] > 0 ? bm.uniq[r * nRb + c] / bm.uniqTot[r] : NaN),
          },
        ],
      };
    }

    /** @type {import('./export/report.js').ReportGather | null} */
    let gather = null;
    const sel = belongsUi.sel;
    const gg = bm && sel >= 0 ? belongsUi.gathers.get(sel) : null;
    if (gg && bm) {
      const labels = matrix ? /** @type {NonNullable<typeof matrix>} */ (matrix).labels : [];
      /** @type {string[]} */
      const legend = [];
      /** @type {string[]} */
      const legendColors = [];
      const colors = [];
      for (let r = 0; r < gg.nR; r++) {
        colors.push(belongsRecColor(r));
        let mass = 0;
        for (let qw = 0; qw < gg.qWin; qw++) mass += gg.paint[qw * gg.nR + r];
        if (mass > 0) {
          legend.push(belongsElide(labels[r] ?? `record ${r + 1}`));
          legendColors.push(belongsRecColor(r));
        }
      }
      legend.push('unexplained');
      legendColors.push(theme.muted);
      const rows = gg.components.slice(0, 6).map(
        (/** @type {any} */ c) =>
          `${belongsPct(c.mass / gg.totMass)} — ${belongsRegion(c.rec, c.lo, c.hi, bm.nRecT)}` +
          ` · ${belongsPct(c.mass > 0 ? c.contested / c.mass : 0)} contested`,
      );
      const unex = 1 - gg.explained / Math.max(1, gg.totMass);
      const cAll = gg.explained > 0 ? gg.contestedTotal / gg.explained : 0;
      gather = {
        title: `where does ${labels[sel] ?? 'the record'} belong?`,
        g: gg,
        colors,
        legend,
        legendColors,
        rows,
        foot:
          `${formatBp(gg.tileBp)} windows · ${belongsPct(cAll)} contested · ` +
          `${belongsPct(unex)} unexplained — claims are disjoint; ties break to load order (parsimony, not affinity)`,
      };
    }

    const cm = buildColormap(mode);
    /** @type {{title: string, svg: string}[]} */
    const charts = [];
    const dist = segmentDistributions(d.segments);
    if (dist) {
      charts.push({
        title: 'segment length (log count)',
        svg: resolveSvgVars(
          groupedBarsSVG({
            binLabels: ladderLabels(dist.lengths.edges),
            series: [
              { name: 'forward', color: cm.fwdFlat, values: dist.lengths.fwd },
              { name: 'reverse', color: cm.revFlat, values: dist.lengths.rev },
            ],
          }),
        ),
      });
      const idLabels = [];
      for (let i = 0; i < dist.identity.fwd.length; i++) {
        idLabels.push(`${((dist.identity.lo + i * dist.identity.width) * 100).toFixed(1)}%`);
      }
      charts.push({
        title: 'anchor identity (log count)',
        svg: resolveSvgVars(
          groupedBarsSVG({
            binLabels: idLabels,
            series: [
              { name: 'forward', color: cm.fwdFlat, values: dist.identity.fwd },
              { name: 'reverse', color: cm.revFlat, values: dist.identity.rev },
            ],
          }),
        ),
      });
    }
    const km = d.stats.kmer;
    if (km) {
      const occ = occupancyBins(km.occCount);
      charts.push({
        title: `k-mer occurrence spectrum (distinct ${km.k}-mers, log count)`,
        svg: resolveSvgVars(
          groupedBarsSVG({
            binLabels: occ.map((o) => o.label),
            series: [{ name: 'distinct', color: cm.fwdFlat, values: occ.map((o) => o.count) }],
          }),
        ),
      });
    }

    const tLabel = d.target.names.length === 1 ? d.target.names[0] : `${d.target.names.length} sequences`;
    const qLabel = state.fileQuery
      ? d.query.names.length === 1
        ? d.query.names[0]
        : `${d.query.names.length} sequences`
      : 'self';
    const sub = [
      `target ${d.target.names.length} seq · ${formatBp(d.target.total)} — query ` +
        `${d.query.names.length} seq · ${formatBp(d.query.total)} · ${formatCount(d.segments.count)} segments · ` +
        (d.source === 'kmer' ? `alignment-free${km ? `, k=${km.k}` : ''}` : 'PAF import'),
      `generated ${new Date().toISOString().slice(0, 10)}` +
        (shareBase ? ` · reproduce: ${location.origin}${location.pathname}?${shareBase}` : ' · local files'),
    ];
    const footer = [];
    if (d.source === 'kmer') {
      footer.push(
        'Plot identity is anchor identity (exact k-mer anchor coverage of each merged run) — deliberately not alignment identity and not ANI.',
      );
    }
    if (bm) {
      footer.push(
        `Belongs: count-weighted canonical ${bm.k}-mer containment` +
          (bm.scaled > 1
            ? `, FracMinHash-estimated over 1/${bm.scaled} of k-mer space (every record sees the same sample)`
            : ' (exact)') +
          ' · shared content is not locus homology — repeat families carry it across unrelated loci.',
      );
    }
    if (gather) {
      footer.push(
        'Gather: greedy cover — each k-mer copy claimed once against both the record and the window; contested = claimable elsewhere.',
      );
    }

    const canvas = await buildReport({
      plot,
      plotDpr: 2,
      dpr: 2,
      title: `dotdot report — ${tLabel} × ${qLabel}`,
      sub,
      theme,
      matrix,
      gather,
      charts,
      footer,
    });
    canvas.toBlob((b) => {
      if (b) downloadBlob(b, 'dotdot-report.png');
    }, 'image/png');
    // The rendered report, for rigs and tests (same spirit as __dotdotCapture).
    lastReportCanvas = canvas;
  } catch (err) {
    toast(`Report failed: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    btnReport.disabled = !state.data;
  }
}
/** @type {HTMLCanvasElement | null} */
let lastReportCanvas = null;
Object.defineProperty(globalThis, '__dotdotReport', {
  value: async () => {
    await exportReport();
    return lastReportCanvas ? lastReportCanvas.toDataURL('image/png') : null;
  },
});
btnReport.addEventListener('click', () => void exportReport());

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
    draw: heatMode() ? 'heat' : aniMode() ? 'ani' : 'seg',
    col: Number(selColorMode.value),
    fwd: chkFwd.checked,
    rev: chkRev.checked,
    auto: chkAutoRefine.checked,
  });
  // Non-default compute options ride along so the recipient's plot matches —
  // taken from the options that actually PRODUCED this plot, not the current
  // field values (editing a dial without Recompute must not change the link).
  // The grammar itself lives in core/share.js, round-trip-tested with
  // readMatchParams.
  const q = new URLSearchParams(shareBase ?? '');
  const mo = /** @type {import('./core/share.js').MatchShareOpts} */ (
    state.data.source === 'kmer' && lastBaseKmer ? lastBaseKmer : matchOpts()
  );
  writeMatchParams(q, mo, currentAniTiles());
  const qs = q.toString();
  const url = `${location.origin}${location.pathname}${qs ? '?' + qs : ''}${hash}`;
  // A local query riding a linkable target (reference window vs local FASTA)
  // makes the link a partial reproduction — say so instead of overclaiming.
  const fullTrip = shareBase !== null && !(queryLocal && state.fileQuery);
  try {
    await navigator.clipboard.writeText(url);
    toast(
      fullTrip
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
  if (heatLike()) {
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
      profile: state.data.stats.kmer?.profile ?? null,
      overlay: state.overlay && chkOverlay.checked ? state.overlay.segments : null,
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
  if (aniMode()) {
    const res = heatBin
      ? ` · ${heatBin.nx}×${heatBin.ny} tiles (${formatBp((heatBin.x1 - heatBin.x0) / heatBin.nx)} each — zoom to refine)`
      : '';
    legendEl.innerHTML =
      `<div class="row"><span class="lab">tile</span><span class="ramp" style="background:${cm.aniRampCss()}"></span></div>` +
      `<div class="row"><span class="lab"></span><span class="lab">${(heatRange.lo * 100).toFixed(1)}% k-mer ANI</span><span style="flex:1"></span><span class="lab">${(heatRange.hi * 100).toFixed(1)}%</span></div>` +
      `<div class="row"><span class="lab" style="white-space:normal">multiset containment — no occurrence cap${res}</span></div>`;
  } else if (heatMode()) {
    // The heatmap's ramp is contrast-stretched to the observed tile range.
    legendEl.innerHTML =
      `<div class="row"><span class="lab">tile</span><span class="ramp" style="background:${cm.rampCss(0)}"></span></div>` +
      `<div class="row"><span class="lab"></span><span class="lab">${(heatRange.lo * 100).toFixed(1)}% anchor identity</span><span style="flex:1"></span><span class="lab">${(heatRange.hi * 100).toFixed(1)}%</span></div>`;
    const sat = state.data.stats.kmer?.saturated;
    if (sat && sat.length > 0) {
      legendEl.innerHTML +=
        `<div class="row"><span class="swatch swatch-hatch"></span> capped repeats — not searched</div>`;
    }
  } else if (colorMode === 2 && state.data.stats.kmer?.profile) {
    legendEl.innerHTML =
      `<div class="row"><span class="lab">seg</span><span class="ramp" style="background:${cm.multRampCss()}"></span></div>` +
      `<div class="row"><span class="lab"></span><span class="lab">1× unique</span><span style="flex:1"></span><span class="lab">≥300× k-mers</span></div>`;
  } else if (colorMode === 0 || colorMode === 2) {
    const lo = `${Math.round(state.identLo * 100)}%`;
    legendEl.innerHTML =
      `<div class="row"><span class="lab">fwd</span><span class="ramp" style="background:${cm.rampCss(0)}"></span></div>` +
      `<div class="row"><span class="lab">rev</span><span class="ramp" style="background:${cm.rampCss(1)}"></span></div>` +
      `<div class="row"><span class="lab"></span><span class="lab">${lo} anchor identity</span><span style="flex:1"></span><span class="lab">100%</span></div>`;
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
  // After a refine merge the count mixes passes — a rate would be fiction.
  const rate = secs > 0 && !s.merged ? `${formatCount(data.segments.count / secs)}/s` : '—';
  const rows = [
    ['segments', `${formatCount(data.segments.count)} · ${rate}`],
    [`${sw(cm.fwdFlat)}forward`, `${formatCount(sc.fwd)} · ${formatBp(sc.bpFwd)}`],
    [`${sw(cm.revFlat)}reverse`, `${formatCount(sc.rev)} · ${formatBp(sc.bpRev)}`],
    ['target', `${data.target.names.length} seq · ${formatBp(data.target.total)}`],
    ['query', `${data.query.names.length} seq · ${formatBp(data.query.total)}`],
    ['compute', `${secs.toFixed(2)} s · ${data.source === 'kmer' ? 'alignment-free' : 'PAF import'}`],
  ];
  if (s.skippedLines) rows.push(['skipped lines', String(formatInt(s.skippedLines))]);
  // Saturation disclosure: how much of the target the repeat cutoff excluded
  // from search entirely — the difference between "empty" and "not looked".
  const sat = s.kmer?.saturated;
  if (sat && sat.length > 0) {
    let satBp = 0;
    for (let i = 0; i < sat.length; i += 2) satBp += sat[i + 1] - sat[i];
    if (satBp > 0) {
      rows.push(['capped repeats', `${formatBp(satBp)} · ${((satBp / data.target.total) * 100).toFixed(1)}% of target`]);
    }
  }
  statsEl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd title="${v}">${v}</dd>`).join('');
  plotStats.hidden = false;
  btnBelongs.hidden = belongsRecordCount() < 2;
}

// ---- distributions popup + consent cards -----------------------------------
// The modal shell (elements, focus management, the shared card builder)
// lives in app/dialogs.js; the card CONTENTS below stay here with the
// compute state their buttons act on.


/**
 * Guarded resubmit for consent-dialog buttons: the dialog snapshots the job
 * and data generation it asked about, and a click after the data moved on
 * (new files, Clear) must not replay stale options onto the new plot.
 * @param {number} gen dataGen at ask time
 * @param {{opts: object, window: {tx0:number,tx1:number,qy0:number,qy1:number} | null} | null} job
 * @param {(job: NonNullable<typeof lastKmer>) => void} fn
 */
function consentResubmit(gen, job, fn) {
  closeConfirm();
  if (!job) return;
  if (gen !== dataGen) {
    toast('The data changed while this dialog was open — nothing was resubmitted.');
    return;
  }
  fn(job);
}

/** @param {{tLenBp: number, gbLo: number, gbHi: number}} m */
function askExactConfirm(m) {
  const gen = dataGen;
  const job = lastKmer;
  const mb = Math.ceil(m.tLenBp / 1e6);
  const ram = (/** @type {number} */ gb) =>
    gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(gb * 1000))} MB`;
  confirmCard(
    'Exact mode wants real memory',
    `True full density on <b>${formatBp(m.tLenBp)}</b> of target indexes every k-mer: roughly ` +
      `<b>${ram(m.gbLo)}–${ram(m.gbHi)}</b> of index RAM and a long compute. Nothing sampled, ` +
      `nothing skipped.`,
    [
      {
        id: 'cf-go',
        label: 'Compute exact — spend the RAM',
        primary: true,
        onClick: () =>
          consentResubmit(gen, job, (j) => submitKmer({ ...j.opts, exactConfirmed: true }, j.window)),
      },
      {
        id: 'cf-auto',
        label: 'Use auto sampling',
        onClick: () =>
          consentResubmit(gen, job, (j) => {
            inSample.value = 'auto';
            submitKmer({ ...j.opts, sample: 'auto', exactMaxBp: undefined }, j.window);
          }),
      },
    ],
    `Pre-approve next time: type <b>off ${mb}M</b> in sampling — it rides share links, and this ` +
      `ask is skipped.`,
  );
}

/**
 * The 16M-segment wall was actually hit (the volume pre-flight predicts most
 * cases, but segment counts aren't exactly predictable from anchors —
 * satellite-rich cross-plots at full density can slip through). Instead of a
 * dead-end toast after minutes of compute, offer the two remedies that
 * actually work, one click each.
 * @param {string} message the wall error text
 * @returns {boolean} true when the recovery card was shown
 */
function wallRecovery(message) {
  if (!message.startsWith(SEGMENT_WALL_ERROR) || !lastKmer) return false;
  const gen = dataGen;
  const job = lastKmer;
  const minRunNow = parseLenOff(inMinRun.value, 0);
  const fixLen = Math.max(300, minRunNow * 2);
  const wallNow = wallOverride || 16_000_000;
  const wallNext = Math.min(64_000_000, wallNow * 2);
  /** @type {import('./app/dialogs.js').CardButton[]} */
  const buttons = [
    {
      id: 'cw-minlen',
      label: `Keep matches ≥ ${formatBp(fixLen)}`,
      primary: true,
      onClick: () =>
        consentResubmit(gen, job, (j) => {
          inMinRun.value = String(fixLen);
          submitKmer({ ...j.opts, minRunLen: fixLen, volumeConfirmed: true }, j.window);
        }),
    },
    {
      id: 'cw-sample',
      label: 'Sample every 4th position',
      onClick: () =>
        consentResubmit(gen, job, (j) => {
          inSample.value = '4';
          submitKmer({ ...j.opts, sample: 4, volumeConfirmed: true }, j.window);
        }),
    },
  ];
  if (wallNext > wallNow) {
    buttons.push({
      id: 'cw-wall',
      label: `Raise the wall to ${Math.round(wallNext / 1e6)}M`,
      onClick: () =>
        consentResubmit(gen, job, (j) => {
          wallOverride = wallNext;
          submitKmer({ ...j.opts, maxSegments: wallNext, volumeConfirmed: true }, j.window);
        }),
    });
  }
  confirmCard(
    `Hit the ${Math.round(wallNow / 1e6)}M-segment wall`,
    `This window's repeat structure produces more than ${Math.round(wallNow / 1e6)}M match ` +
      `segments at these settings. Ways through:`,
    buttons,
    `The length filter keeps long-range structure and drops repeat confetti; sampling thins ` +
      `everything evenly. Raising the wall recomputes and keeps everything — ` +
      `~${Math.round((wallNext * 70) / 1e9)} GB of RAM+GPU at ${Math.round(wallNext / 1e6)}M, ` +
      `frame rate roughly halves per doubling, and your GPU may refuse the buffer (64M is the ` +
      `engine's hard limit). The ANI heatmap shows full repeat depth without enumerating at all.`,
  );
  return true;
}

/**
 * Anchor-volume pre-flight ask: this window's repeat structure predicts a
 * quadratic enumeration. Proceed grinds it out (and may hit the 16M-segment
 * wall, which has its own error); the fix button keeps runs ≥ 300 bp —
 * HOR-scale structure without monomer confetti — at similar compute time.
 * @param {{estAnchors: number, estUpper?: boolean, tableGb?: number, tLenBp: number}} m
 */
function askVolumeConfirm(m) {
  const gen = dataGen;
  const job = lastKmer;
  const minRunNow = parseLenOff(inMinRun.value, 0);
  const fixLen = Math.max(300, minRunNow);
  const ramLine = m.tableGb
    ? ` The diagonal run-table alone may need <b>~${m.tableGb} GB of RAM</b> — chance anchors ` +
      'at low k land on mostly-distinct diagonals.'
    : '';
  confirmCard(
    'Deep repeat enumeration ahead',
    `At these settings this ${formatBp(m.tLenBp)} window enumerates ` +
      `${m.estUpper ? 'up to' : 'roughly'} <b>${formatCount(m.estAnchors)} anchor pairs</b>` +
      `${m.estUpper ? ' (an upper bound — the deepest repeat bin may cap below its full depth)' : ''} ` +
      `— satellite arrays are quadratic. Expect a long grind, and likely the segment wall.` +
      ramLine +
      ` The heatmap and k-mer multiplicity lane already show this structure without enumerating it.`,
    [
      {
        id: 'cv-minlen',
        label: `Keep matches ≥ ${formatBp(fixLen)}`,
        primary: true,
        onClick: () =>
          consentResubmit(gen, job, (j) => {
            inMinRun.value = String(fixLen);
            submitKmer({ ...j.opts, minRunLen: fixLen, volumeConfirmed: true }, j.window);
          }),
      },
      {
        id: 'cv-sample',
        label: 'Sample every 4th position',
        onClick: () =>
          consentResubmit(gen, job, (j) => {
            inSample.value = '4';
            submitKmer({ ...j.opts, sample: 4, volumeConfirmed: true }, j.window);
          }),
      },
      {
        id: 'cv-go',
        label: 'Enumerate everything anyway',
        onClick: () =>
          consentResubmit(gen, job, (j) => submitKmer({ ...j.opts, volumeConfirmed: true }, j.window)),
      },
    ],
    `The length filter drops monomer-scale confetti at emit time — HOR-scale structure stays, ` +
      `segment counts collapse; anchor time is similar. Sampling thins the anchors themselves — ` +
      `the lever that also shrinks the run-table's RAM.`,
  );
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
  enterModal(statsPop);
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
      `target — the right-hand tail is the repeat fraction of the genome.` +
      (() => {
        let satBp = 0;
        for (let i = 0; i < km.saturated.length; i += 2) satBp += km.saturated[i + 1] - km.saturated[i];
        return satBp > 0
          ? ` <b>${formatBp(satBp)}</b> of the target (${((satBp / d.target.total) * 100).toFixed(1)}%) is ` +
            `repeats above the cutoff — matches there were <b>not enumerated</b> (hatched in the heatmap ` +
            `view). Raising the repeat budget digs deeper, but satellite families with repeat period ` +
            `shorter than k are unenumerable by nature — the hatch is the honest answer there.`
          : '';
      })() +
      `</p></div>`;
  }
  html += '</div>';
  return html;
}
btnStatsDetail.addEventListener('click', openStatsPop);

// ---- Belongs: record × record containment + gather decomposition ----------
// One scoreboard link; everything else lives in the on-demand card (it
// shares the stats modal shell). The numbers are count-weighted CANONICAL
// k-mer containment — the ANI heatmap's tile statistic lifted to whole
// records — computed by the worker over a FracMinHash value-sample when the
// input is large (value sampling keeps cross-record ratios unbiased where
// position striding would not). Shared content ≠ locus homology; the card
// and the help entry both say so.

/** @type {{gen: number, k: number, matrix: any, gathers: Map<number, any>, sel: number, pending: number, win: string, view: 'card' | 'methods', cells: 'shared' | 'excl' | 'uniq'}} */
let belongsUi = { gen: -1, k: 0, matrix: null, gathers: new Map(), sel: -1, pending: -1, win: '', view: 'card', cells: 'shared' };

function belongsRecordCount() {
  const d = state.data;
  if (!d || d.source !== 'kmer' || !state.fileTarget) return 0;
  return d.target.names.length + (state.fileQuery ? d.query.names.length : 0);
}

/** @param {number | null} [rec] null → the matrix; a record index → its gather */
function submitBelongs(rec = null) {
  if (!state.fileTarget) return;
  lastBelongs = { rec };
  lastSubmitKind = 'belongs';
  const sendData = workerGen !== dataGen;
  const winBp = rec != null && belongsUi.win ? parseBp(belongsUi.win) : 0;
  submit({
    type: 'belongs',
    gen: dataGen,
    opts: { k: currentK(), rec: rec ?? undefined, win: winBp > 0 ? winBp : undefined },
    target: sendData ? state.fileTarget.bufs : null,
    query: sendData ? (state.fileQuery ? state.fileQuery.bufs : null) : null,
  });
  workerGen = dataGen;
}

function openBelongsPop() {
  if (!state.data) return;
  if (state.computing) {
    toast('Wait for the current compute to finish, then open Belongs.');
    return;
  }
  if (belongsUi.gen !== dataGen || belongsUi.k !== currentK()) {
    belongsUi = { gen: dataGen, k: currentK(), matrix: null, gathers: new Map(), sel: -1, pending: -1, win: '', view: 'card', cells: 'shared' };
  }
  renderBelongs();
  statsPop.hidden = false;
  enterModal(statsPop);
  if (!belongsUi.matrix) submitBelongs();
}
btnBelongs.addEventListener('click', openBelongsPop);

/** The modal is open and currently showing the belongs card. */
function belongsCardOpen() {
  return !statsPop.hidden && !!statsPop.querySelector('#belongs-card');
}

/** @param {any} msg */
function onBelongsResult(msg) {
  if (belongsUi.gen !== dataGen || belongsUi.k !== msg.k) return; // superseded ask
  belongsUi.matrix = msg;
  if (belongsCardOpen()) renderBelongs();
}

/** @param {any} msg */
function onBelongsGather(msg) {
  if (belongsUi.gen !== dataGen || belongsUi.k !== msg.k) return;
  belongsUi.gathers.set(msg.rec, msg);
  if (belongsUi.pending === msg.rec) belongsUi.pending = -1;
  belongsUi.sel = msg.rec;
  if (belongsCardOpen()) renderBelongs();
}

/** Record label: target names first, then query names; disambiguate collisions. @param {number} i @param {number} nRecT */
function belongsLabel(i, nRecT) {
  const d = /** @type {PlotData} */ (state.data);
  const name = i < nRecT ? d.target.names[i] : d.query.names[i - nRecT];
  const other = i < nRecT ? (state.fileQuery ? d.query.names : []) : d.target.names;
  return other.includes(name) ? `${name} (${i < nRecT ? 'x' : 'y'})` : name;
}

/** Genomic-coordinate range of a record window (1-based, display offsets honored). @param {number} rec @param {number} lo @param {number} hi @param {number} nRecT */
function belongsRegion(rec, lo, hi, nRecT) {
  const d = /** @type {PlotData} */ (state.data);
  const cat = rec < nRecT ? d.target : d.query;
  const j = rec < nRecT ? rec : rec - nRecT;
  const off = cat.offsets ? cat.offsets[j] : 0;
  return `${cat.names[j]}:${formatInt(off + lo + 1)}-${formatInt(off + hi)}`;
}

/** Hex of the viridis ANI ramp at t ∈ [0,1]. @param {number} t */
function aniHex(t) {
  const a = buildColormap(mode).aniData;
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
  return `#${((1 << 24) | (a[i] << 16) | (a[i + 1] << 8) | a[i + 2]).toString(16).slice(1)}`;
}

/** Categorical record color for the position strip: golden-angle OKLCH hues. @param {number} i */
function belongsRecColor(i) {
  const h = ((i * 137.508 + 30) % 360) * (Math.PI / 180);
  return rgbToHex(oklchToSrgb(0.72, 0.12, h));
}

/** @param {number} x fraction → percent label */
function belongsPct(x) {
  return x >= 0.095 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`;
}

/** @param {string} s */
function belongsEsc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** @param {string} s */
function belongsElide(s) {
  return s.length > 14 ? `${s.slice(0, 13)}…` : s;
}

function renderBelongs() {
  const d = state.data;
  if (!d) return;
  if (belongsUi.view === 'methods') {
    statsPop.innerHTML =
      `<div class="stats-card" id="belongs-card">` +
      `<div class="stats-head"><h3><button class="linklike" id="belongs-back">← Belongs</button> — methods</h3>` +
      `<button class="stats-close" aria-label="close">×</button></div>` +
      BELONGS_METHODS +
      `</div>`;
    bindBelongs();
    return;
  }
  const m = belongsUi.matrix;
  let html =
    `<div class="stats-card" id="belongs-card">` +
    `<div class="stats-head"><h3>Belongs — shared content by record ` +
    `<button class="help" data-help="belongs" aria-label="about the belongs matrix" aria-expanded="false">?</button></h3>` +
    `<button class="stats-close" aria-label="close">×</button></div>`;
  if (!m) {
    html += `<p class="stats-sum">Scanning records — count-weighted canonical ${currentK()}-mer containment…</p></div>`;
    statsPop.innerHTML = html;
    bindBelongs();
    return;
  }
  const { nR, nRecT, k, scaled } = m;
  const shared = /** @type {Float64Array} */ (m.shared);
  const exclusive = /** @type {Float64Array} */ (m.exclusive);
  const uniqM = /** @type {Float64Array} */ (m.uniq);
  const uniqTot = /** @type {Float64Array} */ (m.uniqTot);
  const crossMass = /** @type {Float64Array} */ (m.crossMass);
  const tot = /** @type {Float64Array} */ (m.tot);
  const self = !state.fileQuery;
  const lab = [];
  for (let i = 0; i < nR; i++) lab.push(belongsLabel(i, nRecT));
  /** @param {number} i @param {number} j */
  const shr = (i, j) => (i < j ? shared[i * nR + j] : shared[j * nR + i]);

  const cellsMode = belongsUi.cells;
  html +=
    `<p class="stats-sum belongs-cellsrow">cells: <select id="belongs-cells" aria-label="cell metric">` +
    `<option value="shared"${cellsMode === 'shared' ? ' selected' : ''}>shared content</option>` +
    `<option value="excl"${cellsMode === 'excl' ? ' selected' : ''}>exclusive to pair</option>` +
    `<option value="uniq"${cellsMode === 'uniq' ? ' selected' : ''}>unique content</option>` +
    `</select> <span class="dim">— hover any cell for every metric</span></p>`;
  let tbl = `<div class="belongs-wrap"><table class="belongs-table"><thead><tr><th>row ⊂ col</th>`;
  for (let c = 0; c < nR; c++) tbl += `<th title="${belongsEsc(lab[c])}">${belongsEsc(belongsElide(lab[c]))}</th>`;
  tbl += `<th></th></tr></thead><tbody>`;
  for (let r = 0; r < nR; r++) {
    tbl += `<tr><th title="${belongsEsc(lab[r])}">${belongsEsc(belongsElide(lab[r]))}</th>`;
    for (let c = 0; c < nR; c++) {
      if (r === c) {
        tbl += `<td class="dim">—</td>`;
        continue;
      }
      const s = shr(r, c);
      const cont = tot[r] > 0 ? s / tot[r] : 0;
      const back = tot[c] > 0 ? s / tot[c] : 0;
      const denom = Math.min(tot[r], tot[c]);
      const ani = denom > 0 && s > 0 ? Math.pow(s / denom, 1 / k) : 0;
      const excl = r < c ? exclusive[r * nR + c] : exclusive[c * nR + r];
      const exclR = tot[r] > 0 ? excl / tot[r] : 0;
      const uniqR = uniqTot[r] > 0 ? uniqM[r * nR + c] / uniqTot[r] : NaN;
      const massRC = crossMass[r * nR + c];
      const massCR = crossMass[c * nR + r];
      const ratio = massCR > 0 ? massRC / massCR : 0;
      // Zoom lands on the plot's axes: columns must be target records; rows
      // must live on the y axis (query records on cross plots, anything on
      // self plots — the axes share one catalog there).
      const zoomable = c < nRecT && (self || r >= nRecT) && cont > 0;
      const titleLines = [
        `${belongsPct(cont)} of ${lab[r]} occurs in ${lab[c]} · ${belongsPct(back)} the other way`,
        `exclusive to this pair: ${belongsPct(exclR)} of ${lab[r]}`,
        Number.isFinite(uniqR)
          ? `unique content: ${belongsPct(uniqR)} of ${lab[r]}’s single-copy k-mers occur in ${lab[c]}`
          : `unique content: — (${lab[r]} has no single-copy k-mers)`,
      ];
      if (s > 0 && (ratio >= 1.15 || ratio <= 1 / 1.15)) {
        titleLines.push(
          ratio >= 1.15
            ? `shared content sits at ~${ratio.toFixed(1)}× higher copy in ${lab[r]}`
            : `shared content sits at ~${(1 / ratio).toFixed(1)}× higher copy in ${lab[c]}`,
        );
      }
      if (ani > 0) titleLines.push(`k-mer ANI ≈ ${(ani * 100).toFixed(1)}%`);
      if (zoomable) titleLines.push('click to zoom the plot here');
      const val = cellsMode === 'excl' ? exclR : cellsMode === 'uniq' ? uniqR : cont;
      const shown = Number.isFinite(val) && val > 0;
      const tint = shown
        ? ` style="background:color-mix(in srgb, ${aniHex(val)} ${Math.round(12 + val * 30)}%, transparent)"`
        : '';
      tbl +=
        `<td${tint} title="${belongsEsc(titleLines.join('\n'))}"` +
        (zoomable ? ` class="zoom" data-r="${r}" data-c="${c}"` : '') +
        `>${shown ? belongsPct(val) : `<span class="dim">${Number.isFinite(val) ? '·' : '—'}</span>`}</td>`;
    }
    tbl += `<td><button class="linklike belongs-where" data-rec="${r}">where?</button></td></tr>`;
  }
  tbl += `</tbody></table></div>`;
  html += tbl;
  html +=
    `<p class="stats-sum">` +
    (scaled === 1
      ? `Exact count-weighted containment — every canonical ${k}-mer counted, copy numbers included. `
      : `FracMinHash estimate: 1/${scaled} of ${k}-mer space, value-sampled so every record sees the same sample. `) +
    `Cell = share of the <i>row’s</i> k-mer mass found in the <i>column</i> — content sharing, not locus ` +
    `homology (repeat families carry it across unrelated loci). Hover for both directions and k-mer ANI; ` +
    `<i>where?</i> decomposes a record over windows of the others. ` +
    `<button class="linklike" id="belongs-methods">Methods…</button></p>`;

  // Gather panel for the selected record.
  const sel = belongsUi.pending >= 0 ? belongsUi.pending : belongsUi.sel;
  if (sel >= 0) {
    const g = belongsUi.gathers.get(sel);
    html +=
      `<div class="stats-chart"><h4>where does ${belongsEsc(lab[sel])} belong? ` +
      `<span class="axis-note">window <input id="belongs-win" list="belongs-win-list" ` +
      `value="${belongsEsc(belongsUi.win || 'auto')}" size="6" spellcheck="false" ` +
      `aria-label="gather window size"><datalist id="belongs-win-list">` +
      `<option value="auto"></option><option value="50kb"></option>` +
      `<option value="250kb"></option><option value="1Mb"></option></datalist></span></h4>`;
    if (!g) {
      html += `<p class="stats-sum">Decomposing over windows of the other records…</p>`;
    } else {
      // Position strip: the record cut into slices, each painted by the
      // record whose windows claimed it — misassembly reads as segmentation.
      const nRr = g.nR;
      const selCat = !self && sel >= nRecT ? d.query : d.target;
      const selJ = !self && sel >= nRecT ? sel - nRecT : sel;
      const recLen = selCat.starts[selJ + 1] - selCat.starts[selJ];
      /** @type {number[]} */
      const present = [];
      for (let r = 0; r < nRr; r++) {
        let mass = 0;
        for (let qw = 0; qw < g.qWin; qw++) mass += g.paint[qw * nRr + r];
        if (mass > 0) present.push(r);
      }
      let strip = `<div class="belongs-strip" role="img" aria-label="record positions painted by claiming source">`;
      for (let qw = 0; qw < g.qWin; qw++) {
        let best = -1;
        let bestM = 0;
        let tot = 0;
        for (const r of present) {
          const mass = g.paint[qw * nRr + r];
          tot += mass;
          if (mass > bestM) {
            bestM = mass;
            best = r;
          }
        }
        const frac = Math.min(1, tot / Math.max(1e-9, g.totalPerQwin[qw]));
        const lo = qw * g.qwinBp;
        const hi = Math.min(recLen, lo + g.qwinBp);
        const title =
          `${belongsRegion(sel, lo, hi, nRecT)} · ${belongsPct(frac)} explained` +
          (best >= 0 ? ` · mostly ${lab[best]}` : '');
        const bg =
          best >= 0 && frac > 0.02
            ? `color-mix(in srgb, ${belongsRecColor(best)} ${Math.round(20 + frac * 70)}%, transparent)`
            : 'transparent';
        strip += `<span style="background:${bg}" title="${belongsEsc(title)}"></span>`;
      }
      strip += `</div>`;
      html += strip;
      let legend = `<div class="belongs-legend">`;
      for (const r of present) {
        legend +=
          `<span class="chip-leg"><span class="swatch" style="background:${belongsRecColor(r)}"></span>` +
          `${belongsEsc(belongsElide(lab[r]))}</span>`;
      }
      legend += `<span class="chip-leg"><span class="swatch swatch-unex"></span>unexplained</span></div>`;
      html += legend;
      const shown = g.components.slice(0, 8);
      let shownMass = 0;
      let list = `<ol class="belongs-list">`;
      for (const c of shown) {
        shownMass += c.mass;
        const cf = c.mass > 0 ? c.contested / c.mass : 0;
        list +=
          `<li><b>${belongsPct(c.mass / g.totMass)}</b> — ` +
          `${belongsEsc(belongsRegion(c.rec, c.lo, c.hi, nRecT))}` +
          `${!self && c.rec >= nRecT ? ' <span class="dim">(y axis)</span>' : ''}` +
          ` <span class="dim">· ${belongsPct(cf)} contested</span></li>`;
      }
      if (g.components.length > shown.length) {
        const rest = g.explained - shownMass;
        list += `<li class="dim">+ ${g.components.length - shown.length} smaller windows (${belongsPct(rest / g.totMass)})</li>`;
      }
      const unex = 1 - g.explained / Math.max(1, g.totMass);
      list += `<li class="dim">unexplained: ${belongsPct(unex)}${g.truncated ? ' (round cap reached — tail counts here)' : ''}</li>`;
      list += `</ol>`;
      html += list;
      const cAll = g.explained > 0 ? g.contestedTotal / g.explained : 0;
      html +=
        `<p class="stats-sum">${formatBp(g.tileBp)} windows · <b>${belongsPct(cAll)} contested</b> — ` +
        `claimed content that also exists in another record. Between such homes the pick is ` +
        `parsimony (ties break to load order), not evidence: read the matrix row for ambiguity. ` +
        `Claims debit both the record’s copies and the window’s, so shares are disjoint.</p>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  statsPop.innerHTML = html;
  bindBelongs();
}

/** Wire the freshly rendered belongs card (innerHTML swaps drop listeners). */
function bindBelongs() {
  const card = statsPop.querySelector('#belongs-card');
  if (!card) return;
  const x = card.querySelector('.stats-close');
  if (x) x.addEventListener('click', closeStatsPop);
  const cellsSel = card.querySelector('#belongs-cells');
  if (cellsSel instanceof HTMLSelectElement) {
    cellsSel.addEventListener('change', () => {
      belongsUi.cells = /** @type {'shared'|'excl'|'uniq'} */ (cellsSel.value);
      renderBelongs();
    });
  }
  const win = card.querySelector('#belongs-win');
  if (win instanceof HTMLInputElement) {
    win.addEventListener('change', () => {
      const t = win.value.trim().toLowerCase();
      const bp = t === '' || t === 'auto' ? 0 : parseBp(t);
      if (t !== '' && t !== 'auto' && !(bp > 0)) {
        toast('Gather window: a size like 250kb, or auto.', true);
        win.value = belongsUi.win || 'auto';
        return;
      }
      belongsUi.win = bp > 0 ? t : '';
      // Window width changes every decomposition — recompute the open one.
      belongsUi.gathers.clear();
      const sel = belongsUi.sel >= 0 ? belongsUi.sel : belongsUi.pending;
      if (sel >= 0 && !state.computing) {
        belongsUi.pending = sel;
        submitBelongs(sel);
        renderBelongs();
      }
    });
  }
  card.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const td = t.closest('td.zoom');
    if (td instanceof HTMLElement && state.view && state.data) {
      const m = belongsUi.matrix;
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      const d = state.data;
      const yr = state.fileQuery ? r - m.nRecT : r;
      const yCat = state.fileQuery ? d.query : d.target;
      closeStatsPop();
      const { pw, ph } = state.sizes;
      state.view.fitRect(d.target.starts[c], yCat.starts[yr], d.target.starts[c + 1], yCat.starts[yr + 1], pw, ph);
      markDirty();
      return;
    }
    if (t.closest('#belongs-methods')) {
      belongsUi.view = 'methods';
      renderBelongs();
      return;
    }
    if (t.closest('#belongs-back')) {
      belongsUi.view = 'card';
      renderBelongs();
      return;
    }
    const wb = t.closest('.belongs-where');
    if (wb instanceof HTMLElement) {
      const rec = Number(wb.dataset.rec);
      if (belongsUi.gathers.has(rec)) {
        belongsUi.sel = rec;
        renderBelongs();
      } else if (state.computing) {
        toast('Still computing — one belongs request at a time.');
      } else {
        belongsUi.pending = rec;
        submitBelongs(rec);
        renderBelongs();
      }
    }
  });
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;
/** @param {string} msg @param {boolean} [isError] */
function toast(msg, isError = false) {
  // Errors interrupt (alert); info waits its turn (status). Set the role
  // before the text so the announcement carries the right urgency.
  toastEl.setAttribute('role', isError ? 'alert' : 'status');
  toastEl.textContent = msg;
  toastEl.className = isError ? 'error' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), isError ? 30000 : 6000);
}
// Reading or copying a toast shouldn't race its timer: hovering pauses it,
// and a click dismisses (unless the click was selecting text to copy).
toastEl.addEventListener('mouseenter', () => clearTimeout(toastTimer));
toastEl.addEventListener('mouseleave', () => {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
});
toastEl.addEventListener('click', () => {
  if (getSelection()?.toString()) return;
  clearTimeout(toastTimer);
  toastEl.hidden = true;
});

/** @param {string} msg */
function fatal(msg) {
  emptyState.innerHTML = `<p style="max-width:420px"><strong>dotdot can’t start:</strong> ${msg}</p>`;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeHelp();
    closeStatsPop();
    closeConfirm();
  }
});

// --------------------------------------------------------------------------
// URL parameters: ?demo=1 | ?paf=url | ?target=url[&query=url] (+ k, gap, occ)

async function initFromUrl() {
  const p = new URLSearchParams(location.search);
  // The matching-params grammar is pure and round-trip-tested in
  // core/share.js — this side only pours the parsed texts into the fields.
  const mp = readMatchParams(p, parseBp);
  if (mp.k !== undefined) {
    inKNum.value = mp.k;
    inK.value = String(Math.min(26, Math.max(8, currentK())));
  }
  if (mp.gap !== undefined) inGap.value = mp.gap;
  if (mp.occ !== undefined) inMaxOcc.value = mp.occ;
  if (mp.minrun !== undefined) inMinRun.value = mp.minrun;
  if (mp.sample !== undefined) inSample.value = mp.sample;
  if (mp.budget !== undefined) inBudget.value = mp.budget;
  if (mp.anitiles !== undefined) inAniTiles.value = mp.anitiles;
  if (mp.wall) wallOverride = mp.wall;
  const urlRegion = p.get('region');
  if (urlRegion) queuedActions = { ...(queuedActions ?? {}), region: urlRegion };
  // URL fetches can be slow; anything the user loads meanwhile bumps the
  // generation and this init must discard itself, like every other loader.
  const gen = ++refLoadGen;
  try {
    if (p.has('ref')) {
      if (p.has('query')) {
        const qUrl = /** @type {string} */ (p.get('query'));
        const q = await fetchAsFile(qUrl);
        if (gen !== refLoadGen) return;
        queryLocal = false;
        queryShareUrl = qUrl;
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
      if (gen !== refLoadGen) return;
      setChip('chip-paf', f);
      computePaf(f.buf);
      shareBase = new URLSearchParams({ paf: /** @type {string} */ (p.get('paf')) }).toString();
    } else if (p.has('target')) {
      if (p.has('overlay')) {
        const o = await fetchAsFile(/** @type {string} */ (p.get('overlay')));
        if (gen !== refLoadGen) return;
        queuedActions = { ...(queuedActions ?? {}), overlay: o };
      }
      const t = await fetchAsFile(/** @type {string} */ (p.get('target')));
      const q = p.has('query') ? await fetchAsFile(/** @type {string} */ (p.get('query'))) : null;
      if (gen !== refLoadGen) return;
      if (q) {
        queryLocal = false; // the target=/query= link itself carries it
        queryShareUrl = null;
        setFasta('query', q);
      }
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

initHelp();
renderAnnoTracks();
void initFromUrl();
