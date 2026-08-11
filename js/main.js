// @ts-check
/**
 * dotdot main thread: UI wiring, camera interactions, and the render loop.
 * All parsing/matching runs in the compute worker; all data drawing runs in
 * WebGL. This file never touches sequence bytes.
 */
import { View } from './core/transform.js';
import { SegmentGrid } from './core/grid.js';
import { segmentEndpoints } from './core/types.js';
import { locate } from './core/catalog.js';
import { resolveRegion, parseBp } from './core/region.js';
import { GlRenderer } from './render/gl.js';
import { drawUnderlay, drawOverlay, LAYOUT } from './render/axes.js';
import { buildColormap, hexToRgb } from './render/colormap.js';
import { formatBp, formatInt, formatCount } from './render/format.js';
import { looksLikePaf } from './io/paf.js';
import { exportPng } from './export/png.js';
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
const statsEl = $('stats');

const inK = /** @type {HTMLInputElement} */ ($('in-k'));
const inKNum = /** @type {HTMLInputElement} */ ($('in-k-num'));
const inGap = /** @type {HTMLInputElement} */ ($('in-gap'));
const inMaxOcc = /** @type {HTMLInputElement} */ ($('in-maxocc'));
const inMinRun = /** @type {HTMLInputElement} */ ($('in-minrun'));
const inMinIdent = /** @type {HTMLInputElement} */ ($('in-minident'));
const outMinIdent = $('out-minident');
const inMinLen = /** @type {HTMLInputElement} */ ($('in-minlen'));
const inSample = /** @type {HTMLInputElement} */ ($('in-sample'));
const chkFwd = /** @type {HTMLInputElement} */ ($('chk-fwd'));
const chkRev = /** @type {HTMLInputElement} */ ($('chk-rev'));
const selColorMode = /** @type {HTMLSelectElement} */ ($('sel-colormode'));
const inWidth = /** @type {HTMLInputElement} */ ($('in-width'));
const outWidth = $('out-width');
const chkMinPx = /** @type {HTMLInputElement} */ ($('chk-minpx'));
const chkAspect = /** @type {HTMLInputElement} */ ($('chk-aspect'));
const chkOverlay = /** @type {HTMLInputElement} */ ($('chk-overlay'));
const rowOverlay = $('row-overlay');
const btnCompute = /** @type {HTMLButtonElement} */ ($('btn-compute'));
const btnPng = /** @type {HTMLButtonElement} */ ($('btn-png'));
const btnSvg = /** @type {HTMLButtonElement} */ ($('btn-svg'));
const btnRefine = /** @type {HTMLButtonElement} */ ($('btn-refine'));

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
  /** @type {{name: string, buf: ArrayBuffer} | null} */
  fileTarget: null,
  /** @type {{name: string, buf: ArrayBuffer} | null} */
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

function spawnWorker() {
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
      onData(msg.data);
    } else if (msg.type === 'overlayResult') {
      setComputing(false);
      onOverlay(msg);
    } else if (msg.type === 'regionResult') {
      setComputing(false);
      onRegionRefined(msg);
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
 * @param {object} payload
 */
function submit(payload) {
  activeReq = ++reqId;
  submitAt = performance.now();
  setComputing(true);
  worker.postMessage({ id: activeReq, ...payload });
}

function cancelCompute() {
  worker.terminate();
  spawnWorker();
  stopPool();
  activeReq = -1;
  setComputing(false);
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
    w.postMessage({
      part: i,
      qLo: parts[i].qLo,
      qHi: parts[i].qHi,
      qSab: plan.qSab,
      rcSab: plan.rcSab,
      kmersSab: plan.kmersSab,
      posSab: plan.posSab,
      bucketsSab: plan.bucketsSab,
      indexMeta: plan.indexMeta,
      opts: plan.opts,
      qStarts: plan.qStarts,
      rcStarts: plan.rcStarts,
      tStarts: plan.tStarts,
      qTotal: plan.qTotal,
      tTotal: plan.tTotal,
    });
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
          if (completed === parts.length) assemblePool(plan, results);
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
 * @param {any} plan
 * @param {any[]} results
 */
function assemblePool(plan, results) {
  poolWorkers = [];
  let total = 0;
  for (const r of results) total += r.count;
  const segments = {
    count: total,
    x: new Float64Array(total),
    y: new Float64Array(total),
    dx: new Float32Array(total),
    dy: new Float32Array(total),
    strand: new Uint8Array(total),
    identity: new Float32Array(total),
  };
  let o = 0;
  for (const r of results) {
    segments.x.set(r.x, o);
    segments.y.set(r.y, o);
    segments.dx.set(r.dx, o);
    segments.dy.set(r.dy, o);
    segments.strand.set(r.strand, o);
    segments.identity.set(r.identity, o);
    o += r.count;
  }
  let identMin = 1;
  for (let i = 0; i < total; i++) {
    if (segments.identity[i] < identMin) identMin = segments.identity[i];
  }
  setComputing(false);
  onData({
    target: plan.target,
    query: plan.query,
    segments,
    source: 'kmer',
    stats: { elapsedMs: performance.now() - submitAt, identMin, note: plan.note },
  });
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

/** Current k, clamped to the engine's 4..26 range. */
function currentK() {
  const v = Math.round(Number(inKNum.value));
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

/** @param {PlotData} data */
function onData(data) {
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
  btnRefine.disabled = !(data.source === 'kmer' && state.fileTarget);
  btnCompute.textContent = data.source === 'kmer' ? 'Recompute' : 'Compute dot plot';

  // Build the picking grid after the first frame so the plot appears
  // immediately; hover activates when it's ready.
  setTimeout(() => {
    if (state.data === data) {
      state.grid = new SegmentGrid(data.segments, data.target.total, data.query.total);
      if (pendingRegion) {
        jumpToRegion(pendingRegion);
        pendingRegion = null;
      }
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
        inMinLen.value = String(options[j]);
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
  if (data.source === 'kmer' && pendingOverlayBuf) {
    const buf = pendingOverlayBuf;
    pendingOverlayBuf = null;
    setChip('chip-paf', { name: overlayName, buf });
    submit({ type: 'pafOverlay', buf, target: data.target, query: data.query });
  }
  markDirty();
}

function computeKmer() {
  if (!state.fileTarget) {
    toast('Load a target FASTA first.');
    return;
  }
  submit({
    type: 'kmer',
    target: state.fileTarget.buf,
    query: state.fileQuery ? state.fileQuery.buf : null,
    opts: matchOpts(),
  });
}

/** @param {ArrayBuffer} buf */
function computePaf(buf) {
  submit({ type: 'paf', buf });
}

/**
 * A PAF landing on an existing plot becomes the aligner-audit overlay; on an
 * empty app it loads standalone.
 * @param {{name: string, buf: ArrayBuffer}} f
 */
function loadPafFile(f) {
  setChip('chip-paf', f);
  if (state.data) {
    overlayName = f.name;
    submit({ type: 'pafOverlay', buf: f.buf, target: state.data.target, query: state.data.query });
  } else {
    computePaf(f.buf);
  }
}

/** @type {string} */
let overlayName = '';
/** @type {ArrayBuffer | null} */
let pendingOverlayBuf = null;

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

/**
 * Default demo: two committed slices of real chr17 vs both NA19240
 * haplotypes, computed alignment-free with minimap2's calls as the audit
 * overlay — 17p11.2 (18.0–19.6 Mb: heterozygous 250 kb inversion + inverted
 * duplication) and the ROI at 10.75–11.05 Mb (heterozygous ~4.9 kb deletion
 * at 10.895 Mb, hap2).
 */
async function loadDemo() {
  try {
    const [t, q, o] = await Promise.all([
      fetchAsFile('testdata/demo/target.fa.gz'),
      fetchAsFile('testdata/demo/query.fa.gz'),
      fetchAsFile('testdata/demo/minimap2_demo.paf'),
    ]);
    pendingOverlayBuf = o.buf;
    overlayName = o.name;
    // Open on structure (17p11.2 is segdup-dense); the length slider
    // reveals the full repeat fabric live.
    inMinLen.value = '500';
    setFasta('query', q);
    setFasta('target', t);
    toast(
      'Real chr17 loci vs both NA19240 haplotypes, alignment-free. 17p11.2: heterozygous 250 kb ' +
        'inversion (hap1) + inverted duplication (hap2). ROI10.9: heterozygous ~5 kb deletion — ' +
        'press G and jump to chr17_ROI10.9:130k-170k. minimap2’s calls overlay in ink.',
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
  const T = 'testdata/real/chr17.fa';
  const Q = 'testdata/real/NA19240_chr17.fa';
  try {
    const [tHead, qHead] = await Promise.all([
      fetch(T, { method: 'HEAD' }).catch(() => null),
      fetch(Q, { method: 'HEAD' }).catch(() => null),
    ]);
    if (tHead?.ok && qHead?.ok) {
      inK.value = '16';
      inKNum.value = '16';
      const o = await fetchAsFile('testdata/real/NA19240_vs_chm13_chr17.paf');
      pendingOverlayBuf = o.buf;
      overlayName = o.name;
      toast(
        'Computing the full 84 Mb × 170 Mb chr17 comparison alignment-free — this takes minutes ' +
          '(Cancel anytime). minimap2’s calls will overlay when it finishes.',
      );
      const t = await fetchAsFile(T);
      const q = await fetchAsFile(Q);
      setFasta('query', q);
      setFasta('target', t);
    } else {
      const f = await fetchAsFile('testdata/real/NA19240_vs_chm13_chr17.paf');
      pendingRegion = 'chr17:18.3M-19.4M';
      setChip('chip-paf', f);
      computePaf(f.buf);
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
 * @param {'target'|'query'} slot
 * @param {{name: string, buf: ArrayBuffer}} f
 */
function setFasta(slot, f) {
  if (slot === 'target') {
    state.fileTarget = f;
    setChip('chip-target', f);
  } else {
    state.fileQuery = f;
    setChip('chip-query', f);
  }
  btnCompute.disabled = !state.fileTarget || state.computing;
  btnCompute.textContent = 'Compute dot plot';
  scheduleAutoCompute();
}

/** @param {string} id @param {{name: string, buf: ArrayBuffer} | null} f */
function setChip(id, f) {
  const el = $(id);
  if (f) {
    el.textContent = `${f.name} · ${formatBytes(f.buf.byteLength)}`;
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
  for (const file of files) {
    const f = await readFile(file);
    if (isPafFile(f)) {
      loadPafFile(f);
    } else if (!state.fileTarget) {
      setFasta('target', f);
    } else if (!state.fileQuery) {
      setFasta('query', f);
    } else {
      setFasta('target', f);
      state.fileQuery = null;
      setChip('chip-query', null);
    }
  }
}

/** @param {string} id @param {(f: {name: string, buf: ArrayBuffer}) => void} fn */
function wireFileInput(id, fn) {
  const input = /** @type {HTMLInputElement} */ ($(id));
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) fn(await readFile(file));
    input.value = '';
  });
}

wireFileInput('file-target', (f) => setFasta('target', f));
wireFileInput('file-query', (f) => setFasta('query', f));
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
  if (files.length > 0) void handleFiles(files);
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

/** @type {string | null} */
let pendingRegion = null;

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
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @param {number} dpr */
function draw(dpr) {
  const { cssW, cssH, pw, ph } = state.sizes;
  const d = displayOpts();

  if (state.view && state.data) {
    /** @type {Float64Array | null} */
    let highlightEp = null;
    if (state.hoverIndex != null) {
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
      showFwd: d.showFwd,
      showRev: d.showRev,
      minIdentity: d.minIdentity,
      minLenBp: d.minLenBp,
      highlight: highlightEp,
      highlightRgb: hexToRgb(cssHexOrFallback(theme.ink)),
      overlayShow: state.overlay !== null && chkOverlay.checked,
      overlayRgb: hexToRgb(cssHexOrFallback(theme.ink)),
    });
  }
  drawUnderlay(underlay, cssW, cssH, dpr, state.view, state.data, theme);
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
  }
  updateReadout(p);
  markDirty();
});

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
  const d = displayOpts();
  const hit = state.grid.nearest(state.view, pw, ph, p.x, p.y, 7);
  if (hit) {
    const s = state.data.segments;
    const i = hit.index;
    const visible =
      (s.strand[i] === 0 ? d.showFwd : d.showRev) &&
      s.identity[i] >= d.minIdentity &&
      s.dx[i] >= d.minLenBp;
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
inMinLen.addEventListener('input', markDirty); // live while typing
for (const el of [chkFwd, chkRev, chkMinPx]) {
  el.addEventListener('change', markDirty);
}
chkAspect.addEventListener('change', fitView);
for (const el of [inK, inKNum, inGap, inMaxOcc, inMinRun]) {
  el.addEventListener('change', () => {
    if (state.data?.source === 'kmer' || state.fileTarget) {
      btnCompute.disabled = state.computing || (!state.fileTarget && state.data?.source !== 'kmer');
    }
  });
}

btnCompute.addEventListener('click', () => {
  if (state.fileTarget) computeKmer();
});
$('btn-demo').addEventListener('click', () => void loadDemo());
$('btn-demo2').addEventListener('click', () => void loadDemo());
$('btn-demo-real').addEventListener('click', () => void loadFullChr17());
$('btn-demo-real2').addEventListener('click', () => void loadFullChr17());
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
 */
function refineView() {
  if (state.computing) return;
  const d = state.data;
  if (!d || d.source !== 'kmer' || !state.view) {
    toast('Refine works on alignment-free plots (FASTA inputs).');
    return;
  }
  if (!state.fileTarget) {
    toast('The original FASTA buffers are no longer loaded — recompute first.');
    return;
  }
  const { pw, ph } = state.sizes;
  const b = state.view.bounds(pw, ph);
  const tx0 = Math.max(0, Math.floor(b.x0));
  const tx1 = Math.min(d.target.total, Math.ceil(b.x1));
  const qy0 = Math.max(0, Math.floor(b.y0));
  const qy1 = Math.min(d.query.total, Math.ceil(b.y1));
  if (tx1 - tx0 < 100 || qy1 - qy0 < 100) {
    toast('The visible window is too small to refine.');
    return;
  }
  if (tx1 - tx0 > d.target.total * 0.9 && qy1 - qy0 > d.query.total * 0.9) {
    toast('Zoom into a region first — Refine recomputes the visible window at full detail.');
    return;
  }
  submit({
    type: 'kmer',
    target: state.fileTarget.buf,
    query: state.fileQuery ? state.fileQuery.buf : null,
    opts: { ...matchOpts(), sample: 1 },
    window: { tx0, tx1, qy0, qy1 },
  });
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
  const merged = {
    count: total,
    x: new Float64Array(total),
    y: new Float64Array(total),
    dx: new Float32Array(total),
    dy: new Float32Array(total),
    strand: new Uint8Array(total),
    identity: new Float32Array(total),
  };
  for (let j = 0; j < keep.length; j++) {
    const i = keep[j];
    merged.x[j] = s.x[i];
    merged.y[j] = s.y[i];
    merged.dx[j] = s.dx[i];
    merged.dy[j] = s.dy[i];
    merged.strand[j] = s.strand[i];
    merged.identity[j] = s.identity[i];
  }
  merged.x.set(ns.x, keep.length);
  merged.y.set(ns.y, keep.length);
  merged.dx.set(ns.dx, keep.length);
  merged.dy.set(ns.dy, keep.length);
  merged.strand.set(ns.strand, keep.length);
  merged.identity.set(ns.identity, keep.length);

  d.segments = merged;
  renderer.setData(merged);
  state.grid = null;
  state.hoverIndex = null;
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
  const lenFilter = parseLenOff(inMinLen.value, 0);
  toast(
    `Refined ${formatBp(w.tx1 - w.tx0)} × ${formatBp(w.qy1 - w.qy0)} at full detail: ` +
      `+${formatCount(ns.count)} segments in the window.` +
      (lenFilter > 0 ? ` Min segment length is ${formatBp(lenFilter)} — lower it to see the fine structure.` : ''),
  );
  markDirty();
}
$('btn-refine').addEventListener('click', refineView);

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
  btnRefine.disabled = true;
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
  state.cursor = stashCursor;
  state.fpsOn = stashFps;
  markDirty();
});

btnSvg.addEventListener('click', () => {
  if (!state.data || !state.view) return;
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
  if (colorMode === 0) {
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

function updateStats() {
  const data = state.data;
  if (!data) return;
  const s = data.stats;
  /** @type {[string, string][]} */
  const rows = [
    ['segments', `${formatCount(data.segments.count)} (${formatInt(data.segments.count)})`],
    ['target', `${data.target.names.length} seq · ${formatBp(data.target.total)}`],
    ['query', `${data.query.names.length} seq · ${formatBp(data.query.total)}`],
    ['source', data.source === 'kmer' ? 'alignment-free k-mers' : 'aligner import (PAF)'],
    ['compute', `${(s.elapsedMs / 1000).toFixed(2)} s`],
  ];
  if (s.skippedLines) rows.push(['skipped lines', formatInt(s.skippedLines)]);
  statsEl.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd title="${v}">${v}</dd>`)
    .join('');
}

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
    '<kbd>R</kbd>/<kbd>0</kbd> fit · <kbd>G</kbd> region box · <kbd>+</kbd>/<kbd>−</kbd> zoom · ' +
    'arrows pan · <kbd>1</kbd>/<kbd>2</kbd> strand toggles · <kbd>P</kbd> fps meter',
  data:
    'Target FASTA = x axis, query FASTA = y axis (one file → self-plot). dotdot computes matches ' +
    'itself, alignment-free; gzipped files are fine. Multi-sequence files get boundary gridlines.',
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
  refine:
    'Recomputes the <i>visible window</i> at full density and merges it into the plot in place ' +
    '— axes, zoom, and the aligner overlay stay put. The way to work: coarse whole-chromosome ' +
    'pass, zoom to a region of interest, refine, repeat. Needs the FASTA inputs still loaded.',
  minident:
    'Hide segments below this identity (matched fraction after gap bridging; for aligner PAFs, ' +
    'nmatch/alnlen). Instant — nothing recomputes.',
  minlen:
    '<b>The</b> dial at genome scale: low reveals the repeat fabric, high shows clean chromosome ' +
    'structure. Type anything ("off", "750", "2kb") — it applies live as you type. Dense results ' +
    'pick a sane starting value automatically.',
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
  if (e.key === 'Escape') closeHelp();
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
  if (p.has('region')) pendingRegion = p.get('region');
  try {
    if (p.has('demo')) {
      await loadDemo();
    } else if (p.has('paf')) {
      const f = await fetchAsFile(/** @type {string} */ (p.get('paf')));
      setChip('chip-paf', f);
      computePaf(f.buf);
    } else if (p.has('target')) {
      if (p.has('overlay')) {
        const o = await fetchAsFile(/** @type {string} */ (p.get('overlay')));
        pendingOverlayBuf = o.buf;
        overlayName = o.name;
        setChip('chip-paf', o);
      }
      const t = await fetchAsFile(/** @type {string} */ (p.get('target')));
      setFasta('target', t);
      if (p.has('query')) {
        const q = await fetchAsFile(/** @type {string} */ (p.get('query')));
        setFasta('query', q);
      }
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

void initFromUrl();
