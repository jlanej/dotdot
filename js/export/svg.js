// @ts-check
/**
 * Publication-quality SVG export of the current viewport. Vector output is
 * capped at 60k visible segments — beyond that the file would be unusable
 * anyway and PNG is the right tool.
 */
import { LAYOUT, LANE_H, LANE_X0, LANE_Y0, computeTicks, boundaryLines, bandLabels, bandStripes, STRIPE_ALPHA, laneRects } from '../render/axes.js';
import { buildColormap, multT } from '../render/colormap.js';
import { segmentEndpoints, segmentVisible } from '../core/types.js';
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
 *          identLo:number, colorMode:0|1|2, widthPx:number}} p.opts
 * @param {import('../render/axes.js').AnnoLane[]} [p.annoX]
 * @param {import('../render/axes.js').AnnoLane[]} [p.annoY]
 * @param {{tileBp:number, mult:Float32Array} | null} [p.profile] target
 *   multiplicity profile — required for colorMode 2 parity with the screen
 * @param {import('../core/types.js').SegmentStore | null} [p.overlay]
 *   aligner-audit overlay segments — exported when shown on screen, so the
 *   file never silently omits data ink the screen was drawing
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
    if (segmentVisible(s, i, opts)) visible.push(i);
  });
  if (visible.length > CAP) {
    throw new Error(
      `${visible.length.toLocaleString('en-US')} segments in view — SVG is capped at ${CAP.toLocaleString('en-US')}. Zoom in or export PNG.`,
    );
  }
  if (p.overlay && p.overlay.count > CAP) {
    throw new Error(
      `The aligner overlay has ${p.overlay.count.toLocaleString('en-US')} calls — SVG is capped at ${CAP.toLocaleString('en-US')}. Hide the overlay or export PNG.`,
    );
  }

  const cm = buildColormap(p.mode);
  const prof = p.profile ?? null;
  /**
   * @param {number} i
   */
  const color = (i) => {
    let row;
    let t;
    if (opts.colorMode === 2 && prof) {
      // Multiplicity of the segment's target midpoint, same scale as the GL
      // texture and the axis lane.
      const tile = Math.min(
        prof.mult.length - 1,
        Math.max(0, Math.floor((s.x[i] + s.dx[i] / 2) / prof.tileBp)),
      );
      t = multT(prof.mult[tile]);
      row = 4;
    } else {
      t = Math.min(1, Math.max(0, (s.identity[i] - opts.identLo) / Math.max(1 - opts.identLo, 1e-6)));
      row = (opts.colorMode === 1 ? 2 : 0) + s.strand[i];
    }
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

  // Aligner-audit overlay: the same ink lines + diamond breakpoint markers
  // the screen draws, clipped to the plot. Omitting them made "publication"
  // exports silently thinner than the figure on screen.
  const overlayParts = [];
  if (p.overlay) {
    const o = p.overlay;
    for (let i = 0; i < o.count; i++) {
      segmentEndpoints(o, i, ep);
      const x0 = LAYOUT.l + view.worldToPxX(ep[0], pw);
      const y0 = LAYOUT.t + view.worldToPxY(ep[1], ph);
      const x1 = LAYOUT.l + view.worldToPxX(ep[2], pw);
      const y1 = LAYOUT.t + view.worldToPxY(ep[3], ph);
      if (Math.max(x0, x1) < LAYOUT.l || Math.min(x0, x1) > LAYOUT.l + pw) continue;
      if (Math.max(y0, y1) < LAYOUT.t || Math.min(y0, y1) > LAYOUT.t + ph) continue;
      overlayParts.push(
        `<line x1="${r2(x0)}" y1="${r2(y0)}" x2="${r2(x1)}" y2="${r2(y1)}" stroke-width="1.7" stroke-opacity="0.8"/>`,
        `<rect x="-2.6" y="-2.6" width="5.2" height="5.2" transform="translate(${r2(x0)} ${r2(y0)}) rotate(45)"/>`,
        `<rect x="-2.6" y="-2.6" width="5.2" height="5.2" transform="translate(${r2(x1)} ${r2(y1)}) rotate(45)"/>`,
      );
    }
  }

  // A small self-contained scale: without it the exported figure's color
  // encoding is uninterpretable standalone.
  /** @param {number} row */
  const rampStops = (row) => {
    const stops = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const o = (row * 256 + Math.round(t * 255)) * 4;
      stops.push(
        `<stop offset="${Math.round(t * 100)}%" stop-color="rgb(${cm.data[o]},${cm.data[o + 1]},${cm.data[o + 2]})"/>`,
      );
    }
    return stops.join('');
  };
  const legendParts = [];
  {
    const lx = p.vpW - LAYOUT.r - 168;
    const ly = LAYOUT.t + 10;
    /** @type {{row: number, label: string}[]} */
    const ramps =
      opts.colorMode === 2 && prof
        ? [{ row: 4, label: 'k-mer multiplicity 1× → ≥300×' }]
        : opts.colorMode === 1
          ? []
          : [
              { row: 0, label: `fwd · anchor identity ${Math.round(opts.identLo * 100)}–100%` },
              { row: 1, label: 'rev' },
            ];
    const flatRows =
      opts.colorMode === 1
        ? [
            { row: 2, label: 'forward' },
            { row: 3, label: 'reverse' },
          ]
        : [];
    const rows = ramps.length + flatRows.length + (p.overlay ? 1 : 0);
    if (rows > 0) {
      const h = 8 + rows * 15;
      legendParts.push(
        `<rect x="${lx - 8}" y="${ly - 6}" width="176" height="${h}" rx="6" fill="${theme.surface}" fill-opacity="0.92" stroke="${theme.baseline}" stroke-width="0.5"/>`,
      );
      let ry = ly + 4;
      for (const rmp of ramps) {
        legendParts.push(
          `<defs><linearGradient id="lg${rmp.row}">${rampStops(rmp.row)}</linearGradient></defs>`,
          `<rect x="${lx}" y="${ry - 4}" width="44" height="8" fill="url(#lg${rmp.row})"/>`,
          `<text x="${lx + 50}" y="${ry + 3}" font-size="9" fill="${theme.inkSecondary}">${esc(rmp.label)}</text>`,
        );
        ry += 15;
      }
      for (const fr of flatRows) {
        const o = (fr.row * 256 + 128) * 4;
        legendParts.push(
          `<rect x="${lx}" y="${ry - 4}" width="16" height="8" fill="rgb(${cm.data[o]},${cm.data[o + 1]},${cm.data[o + 2]})"/>`,
          `<text x="${lx + 22}" y="${ry + 3}" font-size="9" fill="${theme.inkSecondary}">${esc(fr.label)}</text>`,
        );
        ry += 15;
      }
      if (p.overlay) {
        legendParts.push(
          `<rect x="${lx + 4}" y="${ry - 3}" width="5.2" height="5.2" transform="rotate(45 ${lx + 6.6} ${ry - 0.4})" fill="${theme.ink}"/>`,
          `<line x1="${lx + 12}" y1="${ry - 0.5}" x2="${lx + 40}" y2="${ry - 0.5}" stroke="${theme.ink}" stroke-width="1.7" stroke-opacity="0.8"/>`,
          `<text x="${lx + 50}" y="${ry + 3}" font-size="9" fill="${theme.inkSecondary}">aligner calls (overlay)</text>`,
        );
      }
    }
  }

  // Chrome geometry comes from the same functions the screen uses, so the
  // export inherits its density gates, per-band offset-aware rulers, label
  // collision rules, and region separators — the file matches the screen
  // by construction.
  const stripes = [];
  for (const st of bandStripes(data.target, b.x0, b.x1, pw)) {
    const xa = LAYOUT.l + view.worldToPxX(st.a, pw);
    const xb = LAYOUT.l + view.worldToPxX(st.b, pw);
    stripes.push(`<rect x="${r2(xa)}" y="${LAYOUT.t}" width="${r2(xb - xa)}" height="${ph}"/>`);
  }
  for (const st of bandStripes(data.query, b.y0, b.y1, ph)) {
    const ya = LAYOUT.t + view.worldToPxY(st.b, ph);
    const yb = LAYOUT.t + view.worldToPxY(st.a, ph);
    stripes.push(`<rect x="${LAYOUT.l}" y="${r2(ya)}" width="${pw}" height="${r2(yb - ya)}"/>`);
  }
  const gridLines = [];
  for (const v of boundaryLines(data.target, b.x0, b.x1, pw)) {
    const x = LAYOUT.l + view.worldToPxX(v, pw);
    gridLines.push(`<line x1="${r2(x)}" y1="${LAYOUT.t}" x2="${r2(x)}" y2="${LAYOUT.t + ph}"/>`);
  }
  for (const v of boundaryLines(data.query, b.y0, b.y1, ph)) {
    const y = LAYOUT.t + view.worldToPxY(v, ph);
    gridLines.push(`<line x1="${LAYOUT.l}" y1="${r2(y)}" x2="${LAYOUT.l + pw}" y2="${r2(y)}"/>`);
  }

  const ticks = [];
  const labels = [];
  const estimate = (/** @type {string} */ t) => t.length * 6.2; // ~11px system font
  for (const tk of computeTicks(data.target, b.x0, b.x1, pw, 90, estimate)) {
    const x = LAYOUT.l + view.worldToPxX(tk.v, pw);
    ticks.push(`<line x1="${r2(x)}" y1="${LAYOUT.t + ph}" x2="${r2(x)}" y2="${LAYOUT.t + ph + 4}"/>`);
    if (tk.labeled) {
      labels.push(`<text x="${r2(x)}" y="${LAYOUT.t + ph + 16}" text-anchor="middle">${esc(tk.label)}</text>`);
    }
  }
  for (const tk of computeTicks(data.query, b.y0, b.y1, ph, 60, () => 12, 0)) {
    const y = LAYOUT.t + view.worldToPxY(tk.v, ph);
    ticks.push(`<line x1="${LAYOUT.l - 4}" y1="${r2(y)}" x2="${LAYOUT.l}" y2="${r2(y)}"/>`);
    if (tk.labeled) {
      labels.push(`<text x="${LAYOUT.l - 7}" y="${r2(y + 3.5)}" text-anchor="end">${esc(tk.label)}</text>`);
    }
  }
  for (const bl of bandLabels(data.target, b.x0, b.x1, pw, (v) => view.worldToPxX(v, pw))) {
    labels.push(
      `<text x="${r2(LAYOUT.l + bl.mid)}" y="${p.vpH - 8}" text-anchor="middle" fill="${theme.inkSecondary}">${esc(bl.name)}</text>`,
    );
  }
  for (const bl of bandLabels(data.query, b.y0, b.y1, ph, (v) => view.worldToPxY(v, ph))) {
    const cy = LAYOUT.t + bl.mid;
    labels.push(
      `<text x="14" y="${r2(cy)}" text-anchor="middle" fill="${theme.inkSecondary}" transform="rotate(-90 14 ${r2(cy)})">${esc(bl.name)}</text>`,
    );
  }

  // Annotation lanes — the same shared geometry the canvas margins use.
  const laneParts = [];
  const annoX = p.annoX ?? [];
  for (let li = 0; li < annoX.length; li++) {
    const yTop = LAYOUT.t + ph + LANE_X0 + li * LANE_H;
    for (const r of laneRects(annoX[li], b.x0, b.x1, pw, theme.accent)) {
      laneParts.push(
        `<rect x="${r2(LAYOUT.l + r.a)}" y="${yTop}" width="${r2(Math.max(r.b - r.a, 1))}" height="11" fill="${r.fill}"/>`,
      );
    }
    laneParts.push(
      `<text x="${LAYOUT.l + pw}" y="${yTop + 9}" text-anchor="end" fill="${theme.muted}" font-size="9">${esc(annoX[li].label)}</text>`,
    );
  }
  const annoY = p.annoY ?? [];
  for (let li = 0; li < annoY.length; li++) {
    const xLeft = LANE_Y0 + li * LANE_H;
    for (const r of laneRects(annoY[li], b.y0, b.y1, ph, theme.accent)) {
      laneParts.push(
        `<rect x="${xLeft}" y="${r2(LAYOUT.t + ph - r.b)}" width="11" height="${r2(Math.max(r.b - r.a, 1))}" fill="${r.fill}"/>`,
      );
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.vpW} ${p.vpH}" width="${p.vpW}" height="${p.vpH}" font-family="system-ui, sans-serif" font-size="11">
  <rect width="${p.vpW}" height="${p.vpH}" fill="${theme.page}"/>
  <rect x="${LAYOUT.l}" y="${LAYOUT.t}" width="${pw}" height="${ph}" fill="${theme.surface}"/>
  <g fill="${theme.ink}" fill-opacity="${STRIPE_ALPHA}">${stripes.join('')}</g>
  <g stroke="${theme.baseline}" stroke-width="1">${gridLines.join('')}</g>
  <clipPath id="plot"><rect x="${LAYOUT.l}" y="${LAYOUT.t}" width="${pw}" height="${ph}"/></clipPath>
  <g clip-path="url(#plot)" stroke-width="${opts.widthPx}" stroke-linecap="round" stroke-opacity="0.85">${lines.join('')}</g>
  <g clip-path="url(#plot)" stroke="${theme.ink}" fill="${theme.ink}" fill-opacity="0.95">${overlayParts.join('')}</g>
  <rect x="${LAYOUT.l}" y="${LAYOUT.t}" width="${pw}" height="${ph}" fill="none" stroke="${theme.baseline}"/>
  <g stroke="${theme.baseline}">${ticks.join('')}</g>
  <g fill="${theme.muted}">${labels.join('')}</g>
  <g>${laneParts.join('')}</g>
  <g>${legendParts.join('')}</g>
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
