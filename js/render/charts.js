// @ts-check
/**
 * Distribution charts for the stats widget: pure data → inline-SVG string
 * builders, no dependencies. Series colors arrive from the caller (the
 * validated strand pair); text and grid wear theme tokens via var(--…),
 * which inline SVG in the DOM resolves like any other element. Everything
 * here is popup-priced: whole-store passes that run on demand, never per
 * frame.
 */
import { formatBp, formatCount } from './format.js';

/** @typedef {import('../core/types.js').SegmentStore} SegmentStore */

/**
 * Upper bin edges on the 1-2-5 ladder covering [lo, hi] (values ≤ edge fall
 * in the bin; the first edge is the smallest ladder rung ≥ lo).
 * @param {number} lo @param {number} hi
 * @returns {number[]}
 */
export function ladderBins(lo, hi) {
  /** @type {number[]} */
  const edges = [];
  const first = Math.max(1, lo);
  let mag = Math.pow(10, Math.floor(Math.log10(first)));
  for (;;) {
    for (const s of [1, 2, 5]) {
      const v = mag * s;
      if (v < first) continue;
      edges.push(v);
      if (v >= hi) return edges;
    }
    mag *= 10;
  }
}

/**
 * Two passes over the store: segment-length bins (1-2-5 log ladder) and
 * identity bins (even widths down to the observed minimum), each split by
 * strand.
 * @param {SegmentStore} s
 */
export function segmentDistributions(s) {
  if (s.count === 0) return null;
  let minLen = Infinity;
  let maxLen = 1;
  let minIdent = 1;
  for (let i = 0; i < s.count; i++) {
    const L = s.dx[i];
    if (L < minLen) minLen = L;
    if (L > maxLen) maxLen = L;
    if (s.identity[i] < minIdent) minIdent = s.identity[i];
  }
  const edges = ladderBins(Math.max(1, minLen), Math.max(1, maxLen));
  const lenFwd = new Float64Array(edges.length);
  const lenRev = new Float64Array(edges.length);

  const identLo = Math.min(0.99, Math.floor(minIdent * 100) / 100);
  const nIdent = Math.max(8, Math.min(40, Math.round((1 - identLo) * 100) * 2));
  const identW = (1 - identLo) / nIdent;
  const idFwd = new Float64Array(nIdent);
  const idRev = new Float64Array(nIdent);

  for (let i = 0; i < s.count; i++) {
    const L = s.dx[i];
    let b = 0;
    while (b < edges.length - 1 && L > edges[b]) b++;
    let ib = Math.floor((s.identity[i] - identLo) / identW);
    if (ib < 0) ib = 0;
    if (ib >= nIdent) ib = nIdent - 1;
    if (s.strand[i] === 0) {
      lenFwd[b]++;
      idFwd[ib]++;
    } else {
      lenRev[b]++;
      idRev[ib]++;
    }
  }
  return {
    lengths: { edges, fwd: lenFwd, rev: lenRev },
    identity: { lo: identLo, width: identW, fwd: idFwd, rev: idRev },
  };
}

/**
 * Log2-ish occurrence classes for the k-mer occurrence spectrum.
 * @param {Float64Array | number[]} occCount distinct k-mer groups per exact
 *   occurrence 1..1023; index 1024 holds everything ≥1024
 * @returns {{label: string, count: number}[]}
 */
export function occupancyBins(occCount) {
  const classes = [
    [1, 1], [2, 2], [3, 4], [5, 8], [9, 16], [17, 32], [33, 64],
    [65, 128], [129, 256], [257, 512], [513, 1023],
  ];
  const out = [];
  for (const [a, b] of classes) {
    let n = 0;
    for (let o = a; o <= b; o++) n += occCount[o] || 0;
    out.push({ label: a === b ? String(a) : `${a}–${b}`, count: n });
  }
  out.push({ label: '≥1024', count: occCount[1024] || 0 });
  return out;
}

/**
 * Grouped thin-bar chart with a log-count y axis (distribution counts span
 * many orders of magnitude; the axis says so explicitly).
 * @param {{
 *   binLabels: string[],
 *   series: {name: string, color: string, values: ArrayLike<number>}[],
 *   width?: number, height?: number,
 * }} spec
 * @returns {string} SVG markup
 */
export function groupedBarsSVG(spec) {
  const W = spec.width ?? 460;
  const H = spec.height ?? 150;
  const padL = 38;
  const padR = 4;
  const padT = 6;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const nBins = spec.binLabels.length;
  const nSer = spec.series.length;

  let maxV = 1;
  for (const s of spec.series) {
    for (let i = 0; i < s.values.length; i++) if (s.values[i] > maxV) maxV = s.values[i];
  }
  const decades = Math.max(1, Math.ceil(Math.log10(maxV)));
  /** @param {number} v */
  const yOf = (v) => (v < 1 ? plotH : plotH - (Math.log10(v) / decades) * plotH);

  const parts = [];
  // Decade gridlines + labels ("log count" axis, stated honestly).
  for (let d = 0; d <= decades; d++) {
    const gy = padT + plotH - (d / decades) * plotH;
    parts.push(
      `<line x1="${padL}" y1="${r1(gy)}" x2="${W - padR}" y2="${r1(gy)}" stroke="var(--grid)" stroke-width="1"/>`,
      `<text x="${padL - 4}" y="${r1(gy + 3)}" text-anchor="end" font-size="9" fill="var(--muted)">${d === 0 ? '1' : formatCount(Math.pow(10, d))}</text>`,
    );
  }
  const groupW = plotW / nBins;
  const barW = Math.max(1.5, (groupW - 2) / nSer - 1);
  for (let b = 0; b < nBins; b++) {
    for (let si = 0; si < nSer; si++) {
      const v = Number(spec.series[si].values[b] ?? 0);
      if (v < 1) continue;
      const x = padL + b * groupW + 1 + si * (barW + 1);
      const y = padT + yOf(v);
      parts.push(
        `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(barW)}" height="${r1(padT + plotH - y)}" rx="1.5" fill="${spec.series[si].color}"/>`,
      );
    }
  }
  // Baseline + a readable subset of bin labels.
  parts.push(`<line x1="${padL}" y1="${padT + plotH + 0.5}" x2="${W - padR}" y2="${padT + plotH + 0.5}" stroke="var(--baseline)" stroke-width="1"/>`);
  const every = Math.max(1, Math.ceil(nBins / 8));
  for (let b = 0; b < nBins; b += every) {
    const cx = padL + (b + 0.5) * groupW;
    parts.push(
      `<text x="${r1(cx)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--muted)">${esc(spec.binLabels[b])}</text>`,
    );
  }
  return (
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="ui-sans-serif, system-ui, sans-serif">` +
    parts.join('') +
    '</svg>'
  );
}

/**
 * Bin labels for a length ladder: "≤10 bp", "≤20 bp", …
 * @param {number[]} edges
 */
export function ladderLabels(edges) {
  return edges.map((e) => formatBp(e));
}

/** @param {number} v */
function r1(v) {
  return Math.round(v * 10) / 10;
}

/** @param {string} s */
function esc(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
