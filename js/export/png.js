// @ts-check
/**
 * PNG export: composite the three stacked canvases (underlay, WebGL data,
 * overlay) at device resolution. The GL context preserves its drawing buffer,
 * so the last rendered frame is always available here.
 */
import { LAYOUT } from '../render/axes.js';
import { downloadBlob } from './download.js';

/**
 * @param {Object} p
 * @param {HTMLCanvasElement} p.underlay
 * @param {HTMLCanvasElement} p.glCanvas
 * @param {HTMLCanvasElement} p.overlay
 * @param {number} p.dpr
 * @param {string} p.filename
 */
export function exportPng(p) {
  const w = p.underlay.width;
  const h = p.underlay.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d'));
  ctx.drawImage(p.underlay, 0, 0);
  ctx.drawImage(p.glCanvas, Math.round(LAYOUT.l * p.dpr), Math.round(LAYOUT.t * p.dpr));
  ctx.drawImage(p.overlay, 0, 0);
  out.toBlob((b) => {
    if (b) downloadBlob(b, p.filename);
  }, 'image/png');
}
