// @ts-check
/**
 * The camera: a pan/zoom view over the world domain (bp on both axes).
 * World y grows upward (query position), screen y grows downward — the flip
 * happens here and only here. All screen units are CSS px.
 */

export class View {
  /**
   * @param {number} domainW total target length (bp)
   * @param {number} domainH total query length (bp)
   */
  constructor(domainW, domainH) {
    this.domainW = domainW;
    this.domainH = domainH;
    this.cx = domainW / 2;
    this.cy = domainH / 2;
    this.bppX = 1; // bp per CSS px
    this.bppY = 1;
  }

  /**
   * Fit the whole domain into the viewport with padding.
   * @param {number} vpW @param {number} vpH
   * @param {boolean} [lockAspect] use one scale for both axes (1 bp is square)
   * @param {number} [pad] fraction of the domain added on each side
   */
  fit(vpW, vpH, lockAspect = false, pad = 0.03) {
    const w = Math.max(this.domainW, 1);
    const h = Math.max(this.domainH, 1);
    this.bppX = (w * (1 + 2 * pad)) / Math.max(vpW, 1);
    this.bppY = (h * (1 + 2 * pad)) / Math.max(vpH, 1);
    if (lockAspect) {
      const b = Math.max(this.bppX, this.bppY);
      this.bppX = b;
      this.bppY = b;
    }
    this.cx = w / 2;
    this.cy = h / 2;
  }

  /** @param {number} wx @param {number} vpW */
  worldToPxX(wx, vpW) {
    return vpW / 2 + (wx - this.cx) / this.bppX;
  }

  /** @param {number} wy @param {number} vpH */
  worldToPxY(wy, vpH) {
    return vpH / 2 - (wy - this.cy) / this.bppY;
  }

  /** @param {number} px @param {number} vpW */
  pxToWorldX(px, vpW) {
    return this.cx + (px - vpW / 2) * this.bppX;
  }

  /** @param {number} py @param {number} vpH */
  pxToWorldY(py, vpH) {
    return this.cy - (py - vpH / 2) * this.bppY;
  }

  /**
   * Drag the content by a pointer delta: the world point under the cursor
   * follows the cursor.
   * @param {number} dxPx @param {number} dyPx
   */
  panPx(dxPx, dyPx) {
    this.cx -= dxPx * this.bppX;
    this.cy += dyPx * this.bppY;
  }

  /**
   * Zoom by `factor` (>1 zooms in) keeping the world point under (px, py)
   * fixed on screen.
   * @param {number} px @param {number} py
   * @param {number} factor
   * @param {number} vpW @param {number} vpH
   * @param {'both'|'x'|'y'} [axes]
   */
  zoomAt(px, py, factor, vpW, vpH, axes = 'both') {
    const wx = this.pxToWorldX(px, vpW);
    const wy = this.pxToWorldY(py, vpH);
    if (axes !== 'y') this.bppX /= factor;
    if (axes !== 'x') this.bppY /= factor;
    this.clampZoom(vpW, vpH);
    if (axes !== 'y') this.cx = wx - (px - vpW / 2) * this.bppX;
    if (axes !== 'x') this.cy = wy + (py - vpH / 2) * this.bppY;
    this.clampPan();
  }

  /**
   * Zoom so the world rect fills the viewport (box zoom).
   * @param {number} wx0 @param {number} wy0 @param {number} wx1 @param {number} wy1
   * @param {number} vpW @param {number} vpH
   */
  fitRect(wx0, wy0, wx1, wy1, vpW, vpH) {
    const w = Math.abs(wx1 - wx0);
    const h = Math.abs(wy1 - wy0);
    if (w < 1e-9 || h < 1e-9) return;
    this.bppX = w / Math.max(vpW, 1);
    this.bppY = h / Math.max(vpH, 1);
    this.cx = (wx0 + wx1) / 2;
    this.cy = (wy0 + wy1) / 2;
    this.clampZoom(vpW, vpH);
    this.clampPan();
  }

  /**
   * Keep zoom within [full-domain overview x1.5, 512 px per bp].
   * @param {number} vpW @param {number} vpH
   */
  clampZoom(vpW, vpH) {
    const minBpp = 1 / 512;
    const maxBppX = (this.domainW * 1.5) / Math.max(vpW, 1);
    const maxBppY = (this.domainH * 1.5) / Math.max(vpH, 1);
    this.bppX = Math.min(Math.max(this.bppX, minBpp), Math.max(maxBppX, minBpp));
    this.bppY = Math.min(Math.max(this.bppY, minBpp), Math.max(maxBppY, minBpp));
  }

  /** Keep the domain from being panned entirely off screen. */
  clampPan() {
    this.cx = Math.min(Math.max(this.cx, -0.25 * this.domainW), 1.25 * this.domainW);
    this.cy = Math.min(Math.max(this.cy, -0.25 * this.domainH), 1.25 * this.domainH);
  }

  /**
   * Visible world rect.
   * @param {number} vpW @param {number} vpH
   */
  bounds(vpW, vpH) {
    return {
      x0: this.pxToWorldX(0, vpW),
      x1: this.pxToWorldX(vpW, vpW),
      y0: this.pxToWorldY(vpH, vpH),
      y1: this.pxToWorldY(0, vpH),
    };
  }
}
