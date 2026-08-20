// @ts-check
/**
 * Report export: one PNG composing the live plot with the belongs grids,
 * the gather panel, and the distribution charts, plus honesty footers.
 *
 * Everything is drawn natively on a 2D canvas — no SVG foreignObject
 * (WebKit does not rasterize it reliably), no DOM screenshots. Plain chart
 * SVGs rasterize fine everywhere via Image, provided the caller resolves
 * CSS var() tokens to literal colors first. Layout is computed by a pure
 * function so the geometry is testable without a canvas.
 */

/** @typedef {{bg: string, panel: string, ink: string, ink2: string, muted: string, border: string, family: string}} ReportTheme */

/**
 * @typedef {Object} ReportLayoutInput
 * @property {number} plotW plot panel width, logical px
 * @property {number} plotH plot panel height, logical px
 * @property {number} subLines header subtitle line count
 * @property {number} nR matrix record count (0 = no matrix panel)
 * @property {number} gridCount how many metric grids (shared/exclusive/unique)
 * @property {number} gatherRows gather component rows (0 = no gather panel)
 * @property {number} chartCount distribution charts (0 = none)
 * @property {number} footerLines
 */

/** Fixed logical metrics shared by layout and drawing. */
export const RL = Object.freeze({
  pad: 18,
  headerTitle: 20,
  subLine: 14,
  gridTitle: 16,
  gridCellW: 56,
  gridCellH: 20,
  gridLabelW: 100,
  gridGap: 22,
  stripH: 16,
  legendH: 16,
  gatherRowH: 15,
  chartW: 460,
  chartH: 150,
  chartTitle: 14,
  chartGap: 18,
  footLine: 13,
  sectionGap: 14,
});

/**
 * Pure layout: panel rectangles and total canvas size, logical px.
 * Grids and charts flow left-to-right and wrap at the report width, which
 * is the plot's width (floored at 720 so panels never crush).
 * @param {ReportLayoutInput} inp
 */
export function reportLayout(inp) {
  const W = Math.max(720, inp.plotW) + 2 * RL.pad;
  let y = RL.pad;
  const header = { x: RL.pad, y, w: W - 2 * RL.pad, h: RL.headerTitle + inp.subLines * RL.subLine + 6 };
  y += header.h + RL.sectionGap;
  const plot = { x: RL.pad + Math.max(0, (W - 2 * RL.pad - inp.plotW) / 2), y, w: inp.plotW, h: inp.plotH };
  y += plot.h + RL.sectionGap;

  /** @type {{x: number, y: number, w: number, h: number}[]} */
  const grids = [];
  if (inp.nR > 0 && inp.gridCount > 0) {
    const gw = RL.gridLabelW + inp.nR * RL.gridCellW;
    const gh = RL.gridTitle + (inp.nR + 1) * RL.gridCellH;
    let x = RL.pad;
    let rowY = y;
    let rowH = 0;
    for (let i = 0; i < inp.gridCount; i++) {
      if (x > RL.pad && x + gw > W - RL.pad) {
        x = RL.pad;
        rowY += rowH + RL.gridGap;
        rowH = 0;
      }
      grids.push({ x, y: rowY, w: gw, h: gh });
      x += gw + RL.gridGap;
      rowH = Math.max(rowH, gh);
    }
    y = rowY + rowH + RL.sectionGap;
  }

  /** @type {{x: number, y: number, w: number, h: number} | null} */
  let gather = null;
  if (inp.gatherRows > 0) {
    const h =
      RL.gridTitle + RL.stripH + 4 + RL.legendH + inp.gatherRows * RL.gatherRowH + RL.footLine + 8;
    gather = { x: RL.pad, y, w: W - 2 * RL.pad, h };
    y += h + RL.sectionGap;
  }

  /** @type {{x: number, y: number, w: number, h: number}[]} */
  const charts = [];
  if (inp.chartCount > 0) {
    let x = RL.pad;
    let rowY = y;
    const ch = RL.chartTitle + RL.chartH;
    for (let i = 0; i < inp.chartCount; i++) {
      if (x > RL.pad && x + RL.chartW > W - RL.pad) {
        x = RL.pad;
        rowY += ch + RL.chartGap;
      }
      charts.push({ x, y: rowY, w: RL.chartW, h: ch });
      x += RL.chartW + RL.chartGap;
    }
    y = rowY + ch + RL.sectionGap;
  }

  const footer = { x: RL.pad, y, w: W - 2 * RL.pad, h: inp.footerLines * RL.footLine + 4 };
  y += footer.h + RL.pad;
  return { W, H: y, header, plot, grids, gather, charts, footer };
}

/**
 * #rrggbb + alpha 0..1 → #rrggbbaa (canvas accepts 8-digit hex).
 * @param {string} hex @param {number} a
 */
function withAlpha(hex, a) {
  const aa = Math.max(0, Math.min(255, Math.round(a * 255)))
    .toString(16)
    .padStart(2, '0');
  return `${hex}${aa}`;
}

/** @param {string} s @param {number} n */
function elide(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * One metric grid: labels + tinted percentage cells, same reading as the
 * card's table (row ⊂ col, tint = the ANI ramp at the cell value).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {string} title
 * @param {string[]} labels
 * @param {(r: number, c: number) => number} valueOf NaN = dash
 * @param {(t: number) => string} aniHex
 * @param {ReportTheme} th
 */
export function drawGrid(ctx, rect, title, labels, valueOf, aniHex, th) {
  const nR = labels.length;
  ctx.font = `600 11px ${th.family}`;
  ctx.fillStyle = th.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, rect.x, rect.y + 11);
  const gx = rect.x;
  const gy = rect.y + RL.gridTitle;
  ctx.font = `10px ${th.family}`;
  for (let c = 0; c < nR; c++) {
    ctx.fillStyle = th.ink;
    ctx.textAlign = 'right';
    ctx.fillText(
      elide(labels[c], 9),
      gx + RL.gridLabelW + (c + 1) * RL.gridCellW - 5,
      gy + RL.gridCellH - 6,
    );
  }
  for (let r = 0; r < nR; r++) {
    const cy = gy + (r + 1) * RL.gridCellH;
    ctx.fillStyle = th.ink;
    ctx.textAlign = 'left';
    ctx.fillText(elide(labels[r], 13), gx, cy + RL.gridCellH - 6);
    for (let c = 0; c < nR; c++) {
      const cx = gx + RL.gridLabelW + c * RL.gridCellW;
      ctx.strokeStyle = th.border;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx + 0.5, cy + 0.5, RL.gridCellW, RL.gridCellH);
      if (r === c) {
        ctx.fillStyle = th.muted;
        ctx.textAlign = 'center';
        ctx.fillText('—', cx + RL.gridCellW / 2, cy + RL.gridCellH - 6);
        continue;
      }
      const v = valueOf(r, c);
      if (Number.isFinite(v) && v > 0) {
        ctx.fillStyle = withAlpha(aniHex(v), 0.12 + v * 0.3);
        ctx.fillRect(cx + 1, cy + 1, RL.gridCellW - 1, RL.gridCellH - 1);
        ctx.fillStyle = th.ink2;
        ctx.textAlign = 'right';
        ctx.fillText(
          v >= 0.095 ? `${Math.round(v * 100)}%` : `${(v * 100).toFixed(1)}%`,
          cx + RL.gridCellW - 5,
          cy + RL.gridCellH - 6,
        );
      } else {
        ctx.fillStyle = th.muted;
        ctx.textAlign = 'center';
        ctx.fillText(Number.isFinite(v) ? '·' : '—', cx + RL.gridCellW / 2, cy + RL.gridCellH - 6);
      }
    }
  }
}

/**
 * @typedef {Object} ReportGather
 * @property {string} title
 * @property {{qWin: number, paint: Float64Array, totalPerQwin: Float64Array, nR: number}} g
 * @property {string[]} colors per-record hex
 * @property {string[]} legend chip labels aligned with legendColors
 * @property {string[]} legendColors
 * @property {string[]} rows component text lines
 * @property {string} foot
 */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {ReportGather} p
 * @param {ReportTheme} th
 */
export function drawGather(ctx, rect, p, th) {
  ctx.font = `600 11px ${th.family}`;
  ctx.fillStyle = th.ink;
  ctx.textAlign = 'left';
  ctx.fillText(p.title, rect.x, rect.y + 11);
  const sy = rect.y + RL.gridTitle;
  const { qWin, paint, totalPerQwin, nR } = p.g;
  const cw = rect.w / qWin;
  ctx.strokeStyle = th.border;
  ctx.strokeRect(rect.x + 0.5, sy + 0.5, rect.w, RL.stripH);
  for (let qw = 0; qw < qWin; qw++) {
    let best = -1;
    let bestM = 0;
    let tot = 0;
    for (let r = 0; r < nR; r++) {
      const mass = paint[qw * nR + r];
      tot += mass;
      if (mass > bestM) {
        bestM = mass;
        best = r;
      }
    }
    const frac = Math.min(1, tot / Math.max(1e-9, totalPerQwin[qw]));
    if (best >= 0 && frac > 0.02) {
      ctx.fillStyle = withAlpha(p.colors[best], 0.2 + frac * 0.7);
      ctx.fillRect(rect.x + qw * cw + 0.5, sy + 1, cw, RL.stripH - 1.5);
    }
  }
  let lx = rect.x;
  const ly = sy + RL.stripH + 4;
  ctx.font = `10px ${th.family}`;
  for (let i = 0; i < p.legend.length; i++) {
    ctx.fillStyle = p.legendColors[i];
    ctx.fillRect(lx, ly + 3, 9, 9);
    ctx.fillStyle = th.ink2;
    ctx.fillText(p.legend[i], lx + 13, ly + 11);
    lx += 13 + ctx.measureText(p.legend[i]).width + 16;
  }
  let ry = ly + RL.legendH;
  for (const row of p.rows) {
    ctx.fillStyle = th.ink2;
    ctx.fillText(elide(row, 130), rect.x, ry + 11);
    ry += RL.gatherRowH;
  }
  ctx.fillStyle = th.muted;
  ctx.fillText(elide(p.foot, 140), rect.x, ry + 11);
}

/**
 * @typedef {Object} ReportSpec
 * @property {HTMLCanvasElement} plot composited plot canvas
 * @property {number} plotDpr the plot canvas' pixel density
 * @property {number} dpr report output density
 * @property {string} title
 * @property {string[]} sub
 * @property {ReportTheme} theme
 * @property {{labels: string[], grids: {title: string, valueOf: (r: number, c: number) => number}[],
 *             aniHex: (t: number) => string} | null} matrix
 * @property {ReportGather | null} gather
 * @property {{title: string, svg: string}[]} charts var()-free SVG strings, 460×150
 * @property {string[]} footer
 */

/**
 * Compose the report. Async: chart SVGs rasterize through Image loads.
 * @param {ReportSpec} spec
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function buildReport(spec) {
  const th = spec.theme;
  const plotW = spec.plot.width / spec.plotDpr;
  const plotH = spec.plot.height / spec.plotDpr;
  const nR = spec.matrix ? spec.matrix.labels.length : 0;
  const lay = reportLayout({
    plotW,
    plotH,
    subLines: spec.sub.length,
    nR,
    gridCount: spec.matrix ? spec.matrix.grids.length : 0,
    gatherRows: spec.gather ? spec.gather.rows.length : 0,
    chartCount: spec.charts.length,
    footerLines: spec.footer.length,
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(lay.W * spec.dpr);
  canvas.height = Math.round(lay.H * spec.dpr);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.scale(spec.dpr, spec.dpr);
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, lay.W, lay.H);

  ctx.fillStyle = th.ink;
  ctx.font = `700 15px ${th.family}`;
  ctx.textAlign = 'left';
  ctx.fillText(spec.title, lay.header.x, lay.header.y + 14);
  ctx.font = `11px ${th.family}`;
  ctx.fillStyle = th.ink2;
  spec.sub.forEach((line, i) => {
    ctx.fillText(line, lay.header.x, lay.header.y + RL.headerTitle + (i + 1) * RL.subLine - 3);
  });

  ctx.strokeStyle = th.border;
  ctx.strokeRect(lay.plot.x - 0.5, lay.plot.y - 0.5, lay.plot.w + 1, lay.plot.h + 1);
  ctx.drawImage(spec.plot, lay.plot.x, lay.plot.y, lay.plot.w, lay.plot.h);

  if (spec.matrix) {
    spec.matrix.grids.forEach((g, i) => {
      const m = /** @type {NonNullable<ReportSpec['matrix']>} */ (spec.matrix);
      drawGrid(ctx, lay.grids[i], g.title, m.labels, g.valueOf, m.aniHex, th);
    });
  }
  if (spec.gather && lay.gather) drawGather(ctx, lay.gather, spec.gather, th);

  for (let i = 0; i < spec.charts.length; i++) {
    const rect = lay.charts[i];
    ctx.font = `600 11px ${th.family}`;
    ctx.fillStyle = th.ink;
    ctx.fillText(spec.charts[i].title, rect.x, rect.y + 11);
    const svg = spec.charts[i].svg.replace(
      '<svg ',
      `<svg width="${RL.chartW}" height="${RL.chartH}" `,
    );
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = () => res(undefined);
      img.onerror = () => rej(new Error('chart rasterize failed'));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    ctx.drawImage(img, rect.x, rect.y + RL.chartTitle, RL.chartW, RL.chartH);
  }

  ctx.font = `10px ${th.family}`;
  ctx.fillStyle = th.muted;
  spec.footer.forEach((line, i) => {
    ctx.fillText(line, lay.footer.x, lay.footer.y + (i + 1) * RL.footLine - 3);
  });
  return canvas;
}
