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
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;

  const b = view.bounds(pw, ph);
  // Interior sequence boundaries, skipped when bands get denser than 6 px.
  const tb = bandsInRange(data.target, b.x0, b.x1);
  if (tb.last >= tb.first && pw / (tb.last - tb.first + 1) > 6) {
    ctx.beginPath();
    for (let i = Math.max(tb.first, 1); i <= tb.last; i++) {
      const px = LAYOUT.l + view.worldToPxX(data.target.starts[i], pw);
      ctx.moveTo(Math.round(px) + 0.5, LAYOUT.t);
      ctx.lineTo(Math.round(px) + 0.5, LAYOUT.t + ph);
    }
    ctx.stroke();
  }
  const qb = bandsInRange(data.query, b.y0, b.y1);
  if (qb.last >= qb.first && ph / (qb.last - qb.first + 1) > 6) {
    ctx.beginPath();
    for (let i = Math.max(qb.first, 1); i <= qb.last; i++) {
      const py = LAYOUT.t + view.worldToPxY(data.query.starts[i], ph);
      ctx.moveTo(LAYOUT.l, Math.round(py) + 0.5);
      ctx.lineTo(LAYOUT.l + pw, Math.round(py) + 0.5);
    }
    ctx.stroke();
  }
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

  // --- X ticks (target axis)
  const bx = view.bounds(pw, ph);
  const xt = niceTicks(bx.x0, bx.x1, pw, 90);
  ctx.fillStyle = theme.muted;
  ctx.strokeStyle = theme.baseline;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  ctx.beginPath();
  for (let v = xt.start; v <= bx.x1 + 1e-9; v += xt.step) {
    if (v < 0 || v > data.target.total) continue;
    const px = LAYOUT.l + view.worldToPxX(v, pw);
    if (px < LAYOUT.l - 0.5 || px > LAYOUT.l + pw + 0.5) continue;
    ctx.moveTo(Math.round(px) + 0.5, LAYOUT.t + ph);
    ctx.lineTo(Math.round(px) + 0.5, LAYOUT.t + ph + 4);
    const label = formatTick(v, xt.step);
    const w = ctx.measureText(label).width;
    if (px - w / 2 > lastRight + 6) {
      ctx.fillText(label, px, LAYOUT.t + ph + 7);
      lastRight = px + w / 2;
    }
  }
  ctx.stroke();

  // --- Y ticks (query axis)
  const yt = niceTicks(bx.y0, bx.y1, ph, 60);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  let lastTop = Infinity;
  let maxYLabelW = 0;
  ctx.beginPath();
  for (let v = yt.start; v <= bx.y1 + 1e-9; v += yt.step) {
    if (v < 0 || v > data.query.total) continue;
    const py = LAYOUT.t + view.worldToPxY(v, ph);
    if (py < LAYOUT.t - 0.5 || py > LAYOUT.t + ph + 0.5) continue;
    ctx.moveTo(LAYOUT.l - 4, Math.round(py) + 0.5);
    ctx.lineTo(LAYOUT.l, Math.round(py) + 0.5);
    if (py + 12 < lastTop) {
      const label = formatTick(v, yt.step);
      maxYLabelW = Math.max(maxYLabelW, ctx.measureText(label).width);
      ctx.fillText(label, LAYOUT.l - 7, py);
      lastTop = py;
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
  const { first, last } = bandsInRange(cat, w0, w1);
  if (last < first || last - first > 60) return;
  for (let i = first; i <= last; i++) {
    const a = Math.max(view.worldToPxX(cat.starts[i], plotPx), 0);
    const b = Math.min(view.worldToPxX(cat.starts[i + 1], plotPx), plotPx);
    const w = b - a;
    if (w < 34) continue;
    draw((a + b) / 2, cat.names[i], w - 10);
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
  const { first, last } = bandsInRange(cat, w0, w1);
  if (last < first || last - first > 60) return;
  for (let i = first; i <= last; i++) {
    // worldToPxY is flipped: band start (low coord) is the *bottom* edge.
    const bot = Math.min(view.worldToPxY(cat.starts[i], plotPx), plotPx);
    const top = Math.max(view.worldToPxY(cat.starts[i + 1], plotPx), 0);
    const h = bot - top;
    if (h < 34) continue;
    ctx.save();
    ctx.translate(14, LAYOUT.t + (top + bot) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(elide(ctx, cat.names[i], h - 10), 0, 0);
    ctx.restore();
  }
}
