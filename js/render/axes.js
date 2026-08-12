// @ts-check
/**
 * The 2D chrome around and under the WebGL data layer:
 *  - underlay canvas: page/surface fills + sequence-boundary gridlines
 *  - overlay canvas: frame, ticks, labels, sequence names, crosshair,
 *    box-zoom selection, FPS meter
 * All text stays in ink/muted tokens; series color never labels text
 * (dataviz rule). World<->px mapping is delegated to View; this module adds
 * the plot-area margins.
 */
import { formatTick } from './format.js';
import { bandsInRange } from '../core/catalog.js';

/** @typedef {import('../core/transform.js').View} View */
/** @typedef {import('../core/types.js').PlotData} PlotData */

export const LAYOUT = Object.freeze({ l: 96, r: 14, t: 14, b: 46 });

/**
 * @typedef {Object} Theme
 * @property {string} page
 * @property {string} surface
 * @property {string} ink
 * @property {string} inkSecondary
 * @property {string} muted
 * @property {string} grid
 * @property {string} baseline
 * @property {string} accent
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssW @param {number} cssH @param {number} dpr
 * @returns {CanvasRenderingContext2D}
 */
function ctx2d(canvas, cssW, cssH, dpr) {
  const W = Math.max(1, Math.round(cssW * dpr));
  const H = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssW @param {number} cssH @param {number} dpr
 * @param {View | null} view
 * @param {PlotData | null} data
 * @param {Theme} theme
 */
export function drawUnderlay(canvas, cssW, cssH, dpr, view, data, theme) {
  const ctx = ctx2d(canvas, cssW, cssH, dpr);
  const pw = cssW - LAYOUT.l - LAYOUT.r;
  const ph = cssH - LAYOUT.t - LAYOUT.b;
  ctx.fillStyle = theme.page;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = theme.surface;
  ctx.fillRect(LAYOUT.l, LAYOUT.t, pw, ph);
  if (!view || !data) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(LAYOUT.l, LAYOUT.t, pw, ph);
  ctx.clip();
  // Region boundaries wear the (stronger) baseline token — they separate
  // coordinate spaces, which is a bigger claim than a tick's gridline.
  ctx.strokeStyle = theme.baseline;
  ctx.lineWidth = 1;

  const b = view.bounds(pw, ph);

  // Region separators: alternating band tints (under the data layer).
  ctx.fillStyle = theme.ink;
  ctx.globalAlpha = STRIPE_ALPHA;
  for (const s of bandStripes(data.target, b.x0, b.x1, pw)) {
    const xa = LAYOUT.l + view.worldToPxX(s.a, pw);
    const xb = LAYOUT.l + view.worldToPxX(s.b, pw);
    ctx.fillRect(xa, LAYOUT.t, xb - xa, ph);
  }
  for (const s of bandStripes(data.query, b.y0, b.y1, ph)) {
    const ya = LAYOUT.t + view.worldToPxY(s.b, ph); // flipped: high coord is the top edge
    const yb = LAYOUT.t + view.worldToPxY(s.a, ph);
    ctx.fillRect(LAYOUT.l, ya, pw, yb - ya);
  }
  ctx.globalAlpha = 1;

  ctx.beginPath();
  for (const v of boundaryLines(data.target, b.x0, b.x1, pw)) {
    const px = LAYOUT.l + view.worldToPxX(v, pw);
    ctx.moveTo(Math.round(px) + 0.5, LAYOUT.t);
    ctx.lineTo(Math.round(px) + 0.5, LAYOUT.t + ph);
  }
  for (const v of boundaryLines(data.query, b.y0, b.y1, ph)) {
    const py = LAYOUT.t + view.worldToPxY(v, ph);
    ctx.moveTo(LAYOUT.l, Math.round(py) + 0.5);
    ctx.lineTo(LAYOUT.l + pw, Math.round(py) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * @param {Object} p
 * @param {HTMLCanvasElement} p.canvas
 * @param {number} p.cssW @param {number} p.cssH @param {number} p.dpr
 * @param {View | null} p.view
 * @param {PlotData | null} p.data
 * @param {Theme} p.theme
 * @param {{x: number, y: number} | null} p.cursor plot-area CSS px
 * @param {{x0:number,y0:number,x1:number,y1:number} | null} p.selection
 * @param {number | null} p.fps
 */
export function drawOverlay(p) {
  const { canvas, cssW, cssH, dpr, view, data, theme } = p;
  const ctx = ctx2d(canvas, cssW, cssH, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  const pw = cssW - LAYOUT.l - LAYOUT.r;
  const ph = cssH - LAYOUT.t - LAYOUT.b;

  ctx.strokeStyle = theme.baseline;
  ctx.lineWidth = 1;
  ctx.strokeRect(LAYOUT.l + 0.5, LAYOUT.t + 0.5, pw - 1, ph - 1);
  if (!view || !data) return;

  const font = '11px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.font = font;

  // --- X ticks (target axis) — shared offset-aware per-band geometry
  const bx = view.bounds(pw, ph);
  ctx.fillStyle = theme.muted;
  ctx.strokeStyle = theme.baseline;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.beginPath();
  for (const tk of computeTicks(data.target, bx.x0, bx.x1, pw, 90, (s) => ctx.measureText(s).width)) {
    const px = LAYOUT.l + view.worldToPxX(tk.v, pw);
    ctx.moveTo(Math.round(px) + 0.5, LAYOUT.t + ph);
    ctx.lineTo(Math.round(px) + 0.5, LAYOUT.t + ph + 4);
    if (tk.labeled) ctx.fillText(tk.label, px, LAYOUT.t + ph + 7);
  }
  ctx.stroke();

  // --- Y ticks (query axis)
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  let maxYLabelW = 0;
  ctx.beginPath();
  for (const tk of computeTicks(data.query, bx.y0, bx.y1, ph, 60, () => 12, 0)) {
    const py = LAYOUT.t + view.worldToPxY(tk.v, ph);
    ctx.moveTo(LAYOUT.l - 4, Math.round(py) + 0.5);
    ctx.lineTo(LAYOUT.l, Math.round(py) + 0.5);
    if (tk.labeled) {
      maxYLabelW = Math.max(maxYLabelW, ctx.measureText(tk.label).width);
      ctx.fillText(tk.label, LAYOUT.l - 7, py);
    }
  }
  ctx.stroke();

  // --- Sequence names
  ctx.fillStyle = theme.inkSecondary;
  drawBandNames(ctx, view, data.target, bx.x0, bx.x1, pw, (mid, name, maxW) => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(elide(ctx, name, maxW), LAYOUT.l + mid, cssH - 16);
  });
  // Deep zoom writes exact positions that fill the left margin — skip the
  // rotated names rather than colliding with them.
  if (maxYLabelW <= LAYOUT.l - 26) {
    drawBandNamesY(ctx, view, data.query, bx.y0, bx.y1, ph);
  }

  // --- Crosshair
  if (p.cursor) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(LAYOUT.l, LAYOUT.t, pw, ph);
    ctx.clip();
    ctx.strokeStyle = theme.muted;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    const cxp = LAYOUT.l + p.cursor.x;
    const cyp = LAYOUT.t + p.cursor.y;
    ctx.moveTo(cxp + 0.5, LAYOUT.t);
    ctx.lineTo(cxp + 0.5, LAYOUT.t + ph);
    ctx.moveTo(LAYOUT.l, cyp + 0.5);
    ctx.lineTo(LAYOUT.l + pw, cyp + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  // --- Box-zoom selection
  if (p.selection) {
    const s = p.selection;
    ctx.save();
    ctx.beginPath();
    ctx.rect(LAYOUT.l, LAYOUT.t, pw, ph);
    ctx.clip();
    const x = LAYOUT.l + Math.min(s.x0, s.x1);
    const y = LAYOUT.t + Math.min(s.y0, s.y1);
    const w = Math.abs(s.x1 - s.x0);
    const h = Math.abs(s.y1 - s.y0);
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = 0.08;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
  }

  // --- FPS meter
  if (p.fps != null) {
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${p.fps.toFixed(0)} fps`, LAYOUT.l + pw - 6, LAYOUT.t + 6);
  }
}

/**
 * @param {number} lo @param {number} hi @param {number} px @param {number} targetSpacing
 */
export function niceTicks(lo, hi, px, targetSpacing) {
  const span = Math.max(hi - lo, 1e-9);
  const raw = (span * targetSpacing) / Math.max(px, 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const step = pow * (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10);
  return { step, start: Math.ceil(lo / step) * step };
}

/**
 * Offset-aware per-band axis ticks — the ONE tick geometry for the canvas
 * chrome and the SVG export. Each visible band is ruled in its own display
 * coordinates (local position plus its @offset when present), so the ruler
 * always agrees with hover/readout — streamed reference slices show true
 * genomic coordinates, multi-record axes restart per sequence. Steps never
 * go below 1 bp (sub-bp steps at max zoom produced runs of identical
 * rounded labels). Ticks come back in axis order with collision-deduped
 * `labeled` flags; `v` is the global axis coordinate for positioning.
 *
 * @param {import('../core/types.js').AxisCatalog} cat
 * @param {number} w0 @param {number} w1 visible world range
 * @param {number} px plot extent along this axis in CSS px
 * @param {number} targetSpacing desired px between ticks
 * @param {(label: string) => number} measure label extent along the axis in
 *   px (text width for x, line height for y; SVG passes estimates)
 * @param {number} [gapPx] minimum px between label edges
 * @returns {{v: number, label: string, labeled: boolean}[]}
 */
export function computeTicks(cat, w0, w1, px, targetSpacing, measure, gapPx = 6) {
  /** @type {{v: number, label: string, labeled: boolean}[]} */
  const out = [];
  const span = Math.max(w1 - w0, 1e-9);
  const pxPerBp = px / span;
  const { first, last } = bandsInRange(cat, w0, w1);
  if (last < first) return out;
  let lastEnd = -Infinity;
  for (let i = first; i <= last; i++) {
    const b0 = cat.starts[i];
    const off = cat.offsets ? cat.offsets[i] : 0;
    const lo = Math.max(w0, b0);
    const hi = Math.min(w1, cat.starts[i + 1]);
    if ((hi - lo) * pxPerBp < 24) continue; // sliver bands keep names only
    // The tick grid lives in display space so labels land on round values.
    const d0 = lo - b0 + off;
    const d1 = hi - b0 + off;
    const t = niceTicks(d0, d1, (hi - lo) * pxPerBp, targetSpacing);
    const step = Math.max(1, t.step);
    for (let dv = Math.ceil(d0 / step) * step; dv <= d1 + 1e-9; dv += step) {
      const v = b0 + (dv - off);
      if (v < lo - 1e-9 || v > hi + 1e-9) continue;
      const label = formatTick(dv, step);
      const along = (v - w0) * pxPerBp;
      const ext = measure(label);
      const labeled = along - ext / 2 > lastEnd + gapPx;
      if (labeled) lastEnd = along + ext / 2;
      out.push({ v, label, labeled });
    }
  }
  return out;
}

/**
 * Interior sequence-boundary positions, with the same density gate the
 * screen applies (hidden when bands average under 6 px).
 * @param {import('../core/types.js').AxisCatalog} cat
 * @param {number} w0 @param {number} w1 @param {number} px
 * @returns {number[]} global axis coordinates
 */
export function boundaryLines(cat, w0, w1, px) {
  /** @type {number[]} */
  const out = [];
  const { first, last } = bandsInRange(cat, w0, w1);
  if (last < first || px / (last - first + 1) <= 6) return out;
  for (let i = Math.max(first, 1); i <= last; i++) out.push(cat.starts[i]);
  return out;
}

/**
 * Alternating-band extents for the region separators: every odd-index band
 * carries a whisper of ink so distinct sequences read as distinct panels.
 * Empty when there is nothing to separate (<2 sequences) or bands are
 * denser than the boundary-line gate. Parity is by absolute band index, so
 * a band keeps its shade while panning.
 * @param {import('../core/types.js').AxisCatalog} cat
 * @param {number} w0 @param {number} w1 @param {number} px
 * @returns {{a: number, b: number}[]} world extents clipped to [w0, w1]
 */
export function bandStripes(cat, w0, w1, px) {
  /** @type {{a: number, b: number}[]} */
  const out = [];
  if (cat.names.length < 2) return out;
  const { first, last } = bandsInRange(cat, w0, w1);
  if (last < first || px / (last - first + 1) <= 6) return out;
  for (let i = first; i <= last; i++) {
    if ((i & 1) === 0) continue;
    out.push({ a: Math.max(w0, cat.starts[i]), b: Math.min(w1, cat.starts[i + 1]) });
  }
  return out;
}

/** The separators' ink opacity — visible at a glance yet still background
 * structure (never competing with data marks); overlapping x/y stripes
 * deepen into the 2D region lattice. 4% proved imperceptible on real
 * displays; 7% reads clearly in both themes. */
export const STRIPE_ALPHA = 0.07;

/**
 * Visible band-name labels with the shared placement rules (≤60 bands,
 * ≥34 px per band, centered midpoints). `worldToPx` maps a global axis
 * coordinate to px along the axis; the y axis passes its flipped mapper.
 * @param {import('../core/types.js').AxisCatalog} cat
 * @param {number} w0 @param {number} w1 @param {number} plotPx
 * @param {(v: number) => number} worldToPx
 * @returns {{mid: number, name: string, maxW: number}[]}
 */
export function bandLabels(cat, w0, w1, plotPx, worldToPx) {
  /** @type {{mid: number, name: string, maxW: number}[]} */
  const out = [];
  const { first, last } = bandsInRange(cat, w0, w1);
  if (last < first || last - first > 60) return out;
  for (let i = first; i <= last; i++) {
    const pa = worldToPx(cat.starts[i]);
    const pb = worldToPx(cat.starts[i + 1]);
    const a = Math.max(Math.min(pa, pb), 0);
    const b = Math.min(Math.max(pa, pb), plotPx);
    const w = b - a;
    if (w < 34) continue;
    out.push({ mid: (a + b) / 2, name: cat.names[i], maxW: w - 10 });
  }
  return out;
}

/**
 * @param {CanvasRenderingContext2D} ctx @param {string} s @param {number} maxW
 */
function elide(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {View} view
 * @param {import('../core/types.js').AxisCatalog} cat
 * @param {number} w0 @param {number} w1 @param {number} plotPx
 * @param {(midPx: number, name: string, maxW: number) => void} draw
 */
function drawBandNames(ctx, view, cat, w0, w1, plotPx, draw) {
  for (const bl of bandLabels(cat, w0, w1, plotPx, (v) => view.worldToPxX(v, plotPx))) {
    draw(bl.mid, bl.name, bl.maxW);
  }
}

/**
 * Query names, rotated -90° along the left edge.
 * @param {CanvasRenderingContext2D} ctx
 * @param {View} view
 * @param {import('../core/types.js').AxisCatalog} cat
 * @param {number} w0 @param {number} w1 @param {number} plotPx
 */
function drawBandNamesY(ctx, view, cat, w0, w1, plotPx) {
  // worldToPxY is flipped; bandLabels handles the min/max ordering.
  for (const bl of bandLabels(cat, w0, w1, plotPx, (v) => view.worldToPxY(v, plotPx))) {
    ctx.save();
    ctx.translate(14, LAYOUT.t + bl.mid);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(elide(ctx, bl.name, bl.maxW), 0, 0);
    ctx.restore();
  }
}
