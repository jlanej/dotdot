// @ts-check
/**
 * WebGL2 instanced segment renderer. One static interleaved buffer per
 * dataset; every frame is a single instanced draw (plus an optional
 * one-instance highlight pass). Display filters (strand, identity, length)
 * are uniforms evaluated in the vertex shader, so toggling them re-renders
 * without touching the buffer.
 */
import { VERT, FRAG } from './shaders.js';
import { segmentEndpoints } from '../core/types.js';
import { buildColormap } from './colormap.js';

/** @typedef {import('../core/types.js').SegmentStore} SegmentStore */
/** @typedef {import('../core/transform.js').View} View */

const FLOATS_PER_INSTANCE = 10;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

export class GlRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      // Keeps the frame readable for PNG export and screenshots at any time,
      // not just in the same task as the draw. The blit cost is negligible
      // next to our render budget.
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('WebGL2 is not available in this browser — dotdot needs it to render.');
    }
    this.gl = gl;
    /** @type {SegmentStore | null} */
    this.store = null;
    this.count = 0;
    /** @type {'light'|'dark'} */
    this.mode = 'light';
    this.lost = false;
    /** @type {(() => void) | null} */
    this.onRestored = null;

    // GPU resources are created in init() — and re-created on context
    // restore — but declared here with definite types: init() always runs
    // before any use, and the checker can't see through the method call.
    /** @type {WebGLProgram} */
    this.program = /** @type {any} */ (null);
    /** @type {Record<string, WebGLUniformLocation | null>} */
    this.u = /** @type {any} */ (null);
    /** @type {WebGLBuffer | null} */
    this.cornerBuf = null;
    /** @type {WebGLBuffer | null} */
    this.instanceBuf = null;
    /** @type {WebGLBuffer | null} */
    this.overlayBuf = null;
    /** @type {WebGLBuffer | null} */
    this.overlayEndBuf = null;
    /** @type {WebGLBuffer | null} */
    this.highlightBuf = null;
    /** @type {WebGLVertexArrayObject | null} */
    this.mainVao = null;
    /** @type {WebGLVertexArrayObject | null} */
    this.overlayVao = null;
    /** @type {WebGLVertexArrayObject | null} */
    this.overlayEndVao = null;
    /** @type {WebGLVertexArrayObject | null} */
    this.highlightVao = null;
    /** @type {WebGLTexture | null} */
    this.colormapTex = null;
    this.highlightScratch = new Float32Array(FLOATS_PER_INSTANCE);
    /** @type {Float32Array | null} */
    this.chunkScratch = null;
    this.overlayCount = 0;
    /** @type {SegmentStore | null} */
    this.overlayStore = null;

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
      if (this.store) this.setData(this.store);
      this.setOverlay(this.overlayStore);
      this.setTheme(this.mode);
      if (this.onRestored) this.onRestored();
    });

    this.init();
  }

  init() {
    const gl = this.gl;
    this.program = linkProgram(gl, VERT, FRAG);
    gl.useProgram(this.program);
    this.u = {
      centerHi: gl.getUniformLocation(this.program, 'uCenterHi'),
      centerLo: gl.getUniformLocation(this.program, 'uCenterLo'),
      pxPerBp: gl.getUniformLocation(this.program, 'uPxPerBp'),
      halfViewPx: gl.getUniformLocation(this.program, 'uHalfViewPx'),
      widthPx: gl.getUniformLocation(this.program, 'uWidthPx'),
      minLenPx: gl.getUniformLocation(this.program, 'uMinLenPx'),
      strandVisible: gl.getUniformLocation(this.program, 'uStrandVisible'),
      minIdentity: gl.getUniformLocation(this.program, 'uMinIdentity'),
      minLenBp: gl.getUniformLocation(this.program, 'uMinLenBp'),
      colormap: gl.getUniformLocation(this.program, 'uColormap'),
      colorMode: gl.getUniformLocation(this.program, 'uColorMode'),
      identLo: gl.getUniformLocation(this.program, 'uIdentLo'),
      alpha: gl.getUniformLocation(this.program, 'uAlpha'),
      forceColor: gl.getUniformLocation(this.program, 'uForceColor'),
    };

    // Shared quad-corner buffer: (along 0..1, across -1..1) triangle strip.
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.instanceBuf = gl.createBuffer();
    this.mainVao = this.makeVao(this.instanceBuf);

    this.overlayBuf = gl.createBuffer();
    this.overlayVao = this.makeVao(this.overlayBuf);
    this.overlayEndBuf = gl.createBuffer();
    this.overlayEndVao = this.makeVao(this.overlayEndBuf);
    // NOTE: this.overlayStore/overlayCount deliberately survive init() —
    // the context-restore handler re-uploads via setOverlay(this.overlayStore)
    // right after init(), which used to find them wiped (base data survived,
    // the overlay silently vanished).

    this.highlightBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuf);
    gl.bufferData(gl.ARRAY_BUFFER, BYTES_PER_INSTANCE, gl.DYNAMIC_DRAW);
    this.highlightVao = this.makeVao(this.highlightBuf);

    this.colormapTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.colormapTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.uploadColormap();

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * @param {WebGLBuffer | null} instanceBuf
   */
  makeVao(instanceBuf) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf);
    for (let loc = 1; loc <= 5; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, (loc - 1) * 8);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  uploadColormap() {
    const gl = this.gl;
    const cm = buildColormap(this.mode);
    gl.bindTexture(gl.TEXTURE_2D, this.colormapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cm.width, cm.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, cm.data);
  }

  /** @param {'light'|'dark'} mode */
  setTheme(mode) {
    this.mode = mode;
    this.uploadColormap();
  }

  /** @param {SegmentStore} store */
  setData(store) {
    this.store = store;
    this.count = store.count;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    // Size the GPU store, then fill through a reused ~10 MB staging chunk:
    // interleaving 8M+ segments into one giant Float32Array spiked the JS
    // heap by hundreds of MB exactly when overall memory already peaks.
    gl.bufferData(gl.ARRAY_BUFFER, store.count * BYTES_PER_INSTANCE, gl.STATIC_DRAW);
    const CHUNK = 262_144; // instances per staging fill
    const scratchLen = Math.min(Math.max(store.count, 1), CHUNK) * FLOATS_PER_INSTANCE;
    if (!this.chunkScratch || this.chunkScratch.length < scratchLen) {
      this.chunkScratch = new Float32Array(scratchLen);
    }
    for (let i0 = 0; i0 < store.count; i0 += CHUNK) {
      const n = Math.min(CHUNK, store.count - i0);
      fillInstanceChunk(store, i0, n, this.chunkScratch);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        i0 * BYTES_PER_INSTANCE,
        this.chunkScratch.subarray(0, n * FLOATS_PER_INSTANCE),
      );
    }
  }

  /**
   * Set (or clear) the aligner-audit overlay: one buffer of alignment lines
   * plus one of zero-length "segments" at their endpoints, which the
   * min-length extension renders as diamond breakpoint markers.
   * @param {SegmentStore | null} store
   */
  setOverlay(store) {
    this.overlayStore = store;
    this.overlayCount = store ? store.count : 0;
    if (!store) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buildInstanceData(store), gl.STATIC_DRAW);

    const endBuf = new Float32Array(store.count * 2 * FLOATS_PER_INSTANCE);
    const ep = new Float64Array(4);
    for (let i = 0; i < store.count; i++) {
      segmentEndpoints(store, i, ep);
      writePoint(endBuf, (i * 2) * FLOATS_PER_INSTANCE, ep[0], ep[1]);
      writePoint(endBuf, (i * 2 + 1) * FLOATS_PER_INSTANCE, ep[2], ep[3]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayEndBuf);
    gl.bufferData(gl.ARRAY_BUFFER, endBuf, gl.STATIC_DRAW);
  }

  clearData() {
    this.store = null;
    this.count = 0;
    this.overlayStore = null;
    this.overlayCount = 0;
  }

  /**
   * @param {Object} opts
   * @param {View} opts.view
   * @param {number} opts.vpW plot area CSS px
   * @param {number} opts.vpH
   * @param {number} opts.dpr
   * @param {[number, number, number]} opts.clear 0..1 rgb
   * @param {number} opts.widthPx CSS px line width
   * @param {number} opts.minLenPx CSS px minimum drawn segment length
   * @param {number} opts.alpha
   * @param {0|1} opts.colorMode
   * @param {number} opts.identLo
   * @param {boolean} opts.showFwd
   * @param {boolean} opts.showRev
   * @param {number} opts.minIdentity
   * @param {number} opts.minLenBp
   * @param {Float64Array | null} opts.highlight world endpoints [x0,y0,x1,y1]
   * @param {[number, number, number]} opts.highlightRgb
   * @param {boolean} [opts.overlayShow]
   * @param {[number, number, number]} [opts.overlayRgb]
   */
  render(opts) {
    const gl = this.gl;
    if (this.lost) return;
    const W = Math.max(1, Math.round(opts.vpW * opts.dpr));
    const H = Math.max(1, Math.round(opts.vpH * opts.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.clearColor(opts.clear[0], opts.clear[1], opts.clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.count === 0 && this.overlayCount === 0 && !opts.highlight) return;

    const v = opts.view;
    const cxHi = Math.fround(v.cx);
    const cyHi = Math.fround(v.cy);

    gl.useProgram(this.program);
    gl.uniform2f(this.u.centerHi, cxHi, cyHi);
    gl.uniform2f(this.u.centerLo, v.cx - cxHi, v.cy - cyHi);
    gl.uniform2f(this.u.pxPerBp, opts.dpr / v.bppX, opts.dpr / v.bppY);
    gl.uniform2f(this.u.halfViewPx, W / 2, H / 2);
    gl.uniform1f(this.u.widthPx, opts.widthPx * opts.dpr);
    gl.uniform1f(this.u.minLenPx, opts.minLenPx * opts.dpr);
    gl.uniform2f(this.u.strandVisible, opts.showFwd ? 1 : 0, opts.showRev ? 1 : 0);
    gl.uniform1f(this.u.minIdentity, opts.minIdentity);
    gl.uniform1f(this.u.minLenBp, opts.minLenBp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colormapTex);
    gl.uniform1i(this.u.colormap, 0);
    gl.uniform1f(this.u.colorMode, opts.colorMode);
    gl.uniform1f(this.u.identLo, opts.identLo);
    gl.uniform1f(this.u.alpha, opts.alpha);
    gl.uniform4f(this.u.forceColor, 0, 0, 0, 0);

    if (this.count > 0) {
      gl.bindVertexArray(this.mainVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    }

    // Aligner-audit overlay: alignment spans as ink lines, breakpoints as
    // diamond markers, drawn over the base layer and exempt from its
    // strand/identity/length display filters.
    if (opts.overlayShow && this.overlayCount > 0) {
      const oc = opts.overlayRgb ?? [0, 0, 0];
      gl.uniform4f(this.u.forceColor, oc[0], oc[1], oc[2], 1);
      gl.uniform2f(this.u.strandVisible, 1, 1);
      gl.uniform1f(this.u.minIdentity, 0);
      gl.uniform1f(this.u.minLenBp, 0);
      gl.uniform1f(this.u.alpha, 0.8);
      gl.uniform1f(this.u.widthPx, 1.7 * opts.dpr);
      gl.uniform1f(this.u.minLenPx, 2.5 * opts.dpr);
      gl.bindVertexArray(this.overlayVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.overlayCount);
      gl.uniform1f(this.u.alpha, 0.95);
      gl.uniform1f(this.u.widthPx, 5.5 * opts.dpr);
      gl.uniform1f(this.u.minLenPx, 5.5 * opts.dpr);
      gl.bindVertexArray(this.overlayEndVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.overlayCount * 2);
      gl.uniform4f(this.u.forceColor, 0, 0, 0, 0);
      gl.uniform1f(this.u.alpha, opts.alpha);
      gl.uniform1f(this.u.widthPx, opts.widthPx * opts.dpr);
      gl.uniform1f(this.u.minLenPx, opts.minLenPx * opts.dpr);
      gl.uniform2f(this.u.strandVisible, opts.showFwd ? 1 : 0, opts.showRev ? 1 : 0);
      gl.uniform1f(this.u.minIdentity, opts.minIdentity);
      gl.uniform1f(this.u.minLenBp, opts.minLenBp);
    }

    if (opts.highlight) {
      const s = this.highlightScratch;
      const [x0, y0, x1, y1] = opts.highlight;
      s[0] = Math.fround(x0);
      s[1] = Math.fround(y0);
      s[2] = x0 - s[0];
      s[3] = y0 - s[1];
      s[4] = Math.fround(x1);
      s[5] = Math.fround(y1);
      s[6] = x1 - s[4];
      s[7] = y1 - s[5];
      s[8] = 1;
      s[9] = 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s);
      gl.uniform4f(this.u.forceColor, opts.highlightRgb[0], opts.highlightRgb[1], opts.highlightRgb[2], 1);
      gl.uniform1f(this.u.widthPx, (opts.widthPx + 2.5) * opts.dpr);
      gl.uniform2f(this.u.strandVisible, 1, 1);
      gl.uniform1f(this.u.minIdentity, 0);
      gl.uniform1f(this.u.minLenBp, 0);
      gl.bindVertexArray(this.highlightVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }
    gl.bindVertexArray(null);
  }
}

/**
 * Interleave segments [i0, i0+n) into per-instance floats at the start of
 * `buf`: split-precision endpoints (hi/lo pairs) plus identity/strand meta.
 * @param {SegmentStore} store @param {number} i0 @param {number} n
 * @param {Float32Array} buf
 */
function fillInstanceChunk(store, i0, n, buf) {
  const ep = new Float64Array(4);
  for (let j = 0; j < n; j++) {
    const i = i0 + j;
    segmentEndpoints(store, i, ep);
    const o = j * FLOATS_PER_INSTANCE;
    const x0h = Math.fround(ep[0]);
    const y0h = Math.fround(ep[1]);
    const x1h = Math.fround(ep[2]);
    const y1h = Math.fround(ep[3]);
    buf[o] = x0h;
    buf[o + 1] = y0h;
    buf[o + 2] = ep[0] - x0h;
    buf[o + 3] = ep[1] - y0h;
    buf[o + 4] = x1h;
    buf[o + 5] = y1h;
    buf[o + 6] = ep[2] - x1h;
    buf[o + 7] = ep[3] - y1h;
    buf[o + 8] = store.identity[i];
    buf[o + 9] = store.strand[i];
  }
}

/**
 * One-shot interleave (overlay-sized inputs).
 * @param {SegmentStore} store
 */
function buildInstanceData(store) {
  const buf = new Float32Array(store.count * FLOATS_PER_INSTANCE);
  fillInstanceChunk(store, 0, store.count, buf);
  return buf;
}

/**
 * Write one zero-length instance at (x, y) — the shader's min-length
 * extension turns it into a diamond marker.
 * @param {Float32Array} buf @param {number} o @param {number} x @param {number} y
 */
function writePoint(buf, o, x, y) {
  const xh = Math.fround(x);
  const yh = Math.fround(y);
  buf[o] = xh;
  buf[o + 1] = yh;
  buf[o + 2] = x - xh;
  buf[o + 3] = y - yh;
  buf[o + 4] = xh;
  buf[o + 5] = yh;
  buf[o + 6] = x - xh;
  buf[o + 7] = y - yh;
  buf[o + 8] = 1;
  buf[o + 9] = 0;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertSrc @param {string} fragSrc
 */
function linkProgram(gl, vertSrc, fragSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('Failed to create WebGL program');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Shader link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} type @param {string} src
 */
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Failed to create shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}
