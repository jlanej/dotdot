// @ts-check
/**
 * PNG export: composite the three stacked canvases (underlay, WebGL data,
 * overlay) at device resolution. The GL context preserves its drawing buffer,
 * so the last rendered frame is always available here.
 */
import { LAYOUT } from '../render/axes.js';
import { downloadBlob } from './download.js';

/**
 * @typedef {Object} CompositeInputs
 * @property {HTMLCanvasElement} underlay
 * @property {HTMLCanvasElement} glCanvas
 * @property {HTMLCanvasElement} overlay
 * @property {number} dpr
 */

/**
 * Stack the three live canvases into one offscreen canvas.
 * @param {CompositeInputs} p
 */
export function compositeCanvases(p) {
  const out = document.createElement('canvas');
  out.width = p.underlay.width;
  out.height = p.underlay.height;
  const ctx = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d'));
  ctx.drawImage(p.underlay, 0, 0);
  ctx.drawImage(p.glCanvas, Math.round(LAYOUT.l * p.dpr), Math.round(LAYOUT.t * p.dpr));
  ctx.drawImage(p.overlay, 0, 0);
  return out;
}

/**
 * @param {CompositeInputs & {filename: string}} p
 */
export function exportPng(p) {
  compositeCanvases(p).toBlob((b) => {
    if (b) downloadBlob(b, p.filename);
  }, 'image/png');
}
