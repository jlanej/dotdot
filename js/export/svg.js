// @ts-check
/**
 * Publication-quality SVG export of the current viewport. Vector output is
 * capped at 60k visible segments — beyond that the file would be unusable
 * anyway and PNG is the right tool.
 */
import { LAYOUT, niceTicks } from '../render/axes.js';
import { buildColormap } from '../render/colormap.js';
import { segmentEndpoints } from '../core/types.js';
import { formatTick } from '../render/format.js';
import { bandsInRange } from '../core/catalog.js';
import { downloadBlob } from './download.js';

/** @typedef {import('../core/types.js').PlotData} PlotData */

const CAP = 60_000;

/**
 * @param {Object} p
 * @param {PlotData} p.data
 * @param {import('../core/grid.js').SegmentGrid} p.grid
 * @param {import('../core/transform.js').View} p.view
 * @param {number} p.vpW component CSS px
 * @param {number} p.vpH
 * @param {import('../render/axes.js').Theme} p.theme
 * @param {'light'|'dark'} p.mode
 * @param {{showFwd:boolean, showRev:boolean, minIdentity:number, minLenBp:number,
 *          identLo:number, colorMode:0|1, widthPx:number}} p.opts
 * @param {string} p.filename
 */
export function exportSvg(p) {
  const { data, grid, view, theme, opts } = p;
  const pw = p.vpW - LAYOUT.l - LAYOUT.r;
  const ph = p.vpH - LAYOUT.t - LAYOUT.b;
  const b = view.bounds(pw, ph);

  /** @type {number[]} */
  const visible = [];
  const s = data.segments;
  grid.query(b.x0, b.y0, b.x1, b.y1, (i) => {
    if (s.strand[i] === 0 && !opts.showFwd) return;
    if (s.strand[i] === 1 && !opts.showRev) return;
    if (s.identity[i] < opts.minIdentity) return;
    if (s.dx[i] < opts.minLenBp) return;
    visible.push(i);
  });
  if (visible.length > CAP) {
    throw new Error(
      `${visible.length.toLocaleString('en-US')} segments in view — SVG is capped at ${CAP.toLocaleString('en-US')}. Zoom in or export PNG.`,
    );
  }

  const cm = buildColormap(p.mode);
  /**
   * @param {number} i
   */
  const color = (i) => {
    const t = Math.min(1, Math.max(0, (s.identity[i] - opts.identLo) / Math.max(1 - opts.identLo, 1e-6)));
    const row = (opts.colorMode === 1 ? 2 : 0) + s.strand[i];
    const o = (row * 256 + Math.round(t * 255)) * 4;
    return `rgb(${cm.data[o]},${cm.data[o + 1]},${cm.data[o + 2]})`;
  };

  const ep = new Float64Array(4);
  const lines = [];
  for (const i of visible) {
    segmentEndpoints(s, i, ep);
    const x0 = LAYOUT.l + view.worldToPxX(ep[0], pw);
    const y0 = LAYOUT.t + view.worldToPxY(ep[1], ph);
    const x1 = LAYOUT.l + view.worldToPxX(ep[2], pw);
    const y1 = LAYOUT.t + view.worldToPxY(ep[3], ph);
    lines.push(
      `<line x1="${r2(x0)}" y1="${r2(y0)}" x2="${r2(x1)}" y2="${r2(y1)}" stroke="${color(i)}"/>`,
    );
  }

  const gridLines = [];
  const tb = bandsInRange(data.target, b.x0, b.x1);
  for (let i = Math.max(tb.first, 1); i <= tb.last; i++) {
    const x = LAYOUT.l + view.worldToPxX(data.target.starts[i], pw);
    gridLines.push(`<line x1="${r2(x)}" y1="${LAYOUT.t}" x2="${r2(x)}" y2="${LAYOUT.t + ph}"/>`);
  }
  const qb = bandsInRange(data.query, b.y0, b.y1);
  for (let i = Math.max(qb.first, 1); i <= qb.last; i++) {
    const y = LAYOUT.t + view.worldToPxY(data.query.starts[i], ph);
    gridLines.push(`<line x1="${LAYOUT.l}" y1="${r2(y)}" x2="${LAYOUT.l + pw}" y2="${r2(y)}"/>`);
  }

  const ticks = [];
  const labels = [];
  const xt = niceTicks(b.x0, b.x1, pw, 90);
  for (let v = xt.start; v <= b.x1; v += xt.step) {
    if (v < 0 || v > data.target.total) continue;
    const x = LAYOUT.l + view.worldToPxX(v, pw);
    ticks.push(`<line x1="${r2(x)}" y1="${LAYOUT.t + ph}" x2="${r2(x)}" y2="${LAYOUT.t + ph + 4}"/>`);
    labels.push(
      `<text x="${r2(x)}" y="${LAYOUT.t + ph + 16}" text-anchor="middle">${esc(formatTick(v, xt.step))}</text>`,
    );
  }
  const yt = niceTicks(b.y0, b.y1, ph, 60);
  for (let v = yt.start; v <= b.y1; v += yt.step) {
    if (v < 0 || v > data.query.total) continue;
    const y = LAYOUT.t + view.worldToPxY(v, ph);
    ticks.push(`<line x1="${LAYOUT.l - 4}" y1="${r2(y)}" x2="${LAYOUT.l}" y2="${r2(y)}"/>`);
    labels.push(
      `<text x="${LAYOUT.l - 7}" y="${r2(y + 3.5)}" text-anchor="end">${esc(formatTick(v, yt.step))}</text>`,
    );
  }
  for (let i = Math.max(tb.first, 0); i <= tb.last; i++) {
    const a = Math.max(view.worldToPxX(data.target.starts[i], pw), 0);
    const bb = Math.min(view.worldToPxX(data.target.starts[i + 1], pw), pw);
    if (bb - a < 34) continue;
    labels.push(
      `<text x="${r2(LAYOUT.l + (a + bb) / 2)}" y="${p.vpH - 8}" text-anchor="middle" fill="${theme.inkSecondary}">${esc(data.target.names[i])}</text>`,
    );
  }
  for (let i = Math.max(qb.first, 0); i <= qb.last; i++) {
    const bot = Math.min(view.worldToPxY(data.query.starts[i], ph), ph);
    const top = Math.max(view.worldToPxY(data.query.starts[i + 1], ph), 0);
    if (bot - top < 34) continue;
    const cy = LAYOUT.t + (top + bot) / 2;
    labels.push(
      `<text x="14" y="${r2(cy)}" text-anchor="middle" fill="${theme.inkSecondary}" transform="rotate(-90 14 ${r2(cy)})">${esc(data.query.names[i])}</text>`,
    );
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.vpW} ${p.vpH}" width="${p.vpW}" height="${p.vpH}" font-family="system-ui, sans-serif" font-size="11">
  <rect width="${p.vpW}" height="${p.vpH}" fill="${theme.page}"/>
  <rect x="${LAYOUT.l}" y="${LAYOUT.t}" width="${pw}" height="${ph}" fill="${theme.surface}"/>
  <g stroke="${theme.grid}" stroke-width="1">${gridLines.join('')}</g>
  <clipPath id="plot"><rect x="${LAYOUT.l}" y="${LAYOUT.t}" width="${pw}" height="${ph}"/></clipPath>
  <g clip-path="url(#plot)" stroke-width="${opts.widthPx}" stroke-linecap="round">${lines.join('')}</g>
  <rect x="${LAYOUT.l}" y="${LAYOUT.t}" width="${pw}" height="${ph}" fill="none" stroke="${theme.baseline}"/>
  <g stroke="${theme.baseline}">${ticks.join('')}</g>
  <g fill="${theme.muted}">${labels.join('')}</g>
</svg>
`;
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), p.filename);
}

/** @param {number} v */
function r2(v) {
  return Math.round(v * 100) / 100;
}

/** @param {string} sIn */
function esc(sIn) {
  return sIn
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
