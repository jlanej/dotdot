// @ts-check
/**
 * Identity-heatmap draw mode (the StainedGlass-style view): visible
 * segments bin into a world-anchored tile grid colored by the best identity
 * seen in each tile — the standard way satellite architecture is figured,
 * made interactive. Pure functions here; the caller owns scheduling and
 * the canvas.
 */

/**
 * @typedef {Object} HeatBin
 * @property {Float32Array} grid max identity per cell (0 = empty)
 * @property {number} nx @property {number} ny
 * @property {number} x0 @property {number} x1 world bounds of the grid
 * @property {number} y0 @property {number} y1
 */

/**
 * Bin segments into an nx×ny max-identity grid over [x0,x1)×[y0,y1).
 * Each segment walks its diagonal cellwise so long matches paint their
 * whole path, strand-aware endpoints included.
 *
 * @param {import('../core/types.js').SegmentStore} s
 * @param {{x0:number, x1:number, y0:number, y1:number}} b
 * @param {number} nx @param {number} ny
 * @param {{showFwd: boolean, showRev: boolean}} opts
 * @returns {HeatBin}
 */
export function binIdentity(s, b, nx, ny, opts) {
  const grid = new Float32Array(nx * ny);
  const spanX = Math.max(b.x1 - b.x0, 1e-9);
  const spanY = Math.max(b.y1 - b.y0, 1e-9);
  const fx = nx / spanX;
  const fy = ny / spanY;
  for (let i = 0; i < s.count; i++) {
    const strand = s.strand[i];
    if (strand === 0 ? !opts.showFwd : !opts.showRev) continue;
    const x = s.x[i];
    const dx = s.dx[i];
    if (x >= b.x1 || x + dx <= b.x0) continue;
    const y = s.y[i];
    const dy = s.dy[i];
    if (y >= b.y1 || y + dy <= b.y0) continue;
    // Strand-aware endpoints: forward runs (x,y)->(x+dx,y+dy), reverse
    // runs (x,y+dy)->(x+dx,y).
    const ax = x;
    const ay = strand === 0 ? y : y + dy;
    const bx = x + dx;
    const by = strand === 0 ? y + dy : y;
    const ident = s.identity[i];
    const cax = (ax - b.x0) * fx;
    const cay = (ay - b.y0) * fy;
    const cbx = (bx - b.x0) * fx;
    const cby = (by - b.y0) * fy;
    // Clip the diagonal to the grid (Liang–Barsky) BEFORE choosing the walk
    // density: a 100 Mb alignment crossing a 10 kb window spans millions of
    // cells, and sampling the unclipped span put at most one sample inside
    // the window (and past 2^31 cells the |0 wrapped negative and skipped
    // the segment outright). The visible crossing is ≤ nx + ny cells, so
    // full coverage is always cheap.
    const dxc = cbx - cax;
    const dyc = cby - cay;
    let t0 = 0;
    let t1 = 1;
    let live = true;
    for (let edge = 0; edge < 4 && live; edge++) {
      const p = edge === 0 ? -dxc : edge === 1 ? dxc : edge === 2 ? -dyc : dyc;
      const q = edge === 0 ? cax : edge === 1 ? nx - cax : edge === 2 ? cay : ny - cay;
      if (p === 0) {
        if (q < 0) live = false;
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) live = false;
          else if (r > t0) t0 = r;
        } else {
          if (r < t0) live = false;
          else if (r < t1) t1 = r;
        }
      }
    }
    if (!live) continue;
    const sx = cax + dxc * t0;
    const sy = cay + dyc * t0;
    const ex = cax + dxc * t1;
    const ey = cay + dyc * t1;
    const steps = Math.min(4096, Math.max(Math.abs(ex - sx), Math.abs(ey - sy), 1) | 0) + 1;
    for (let t = 0; t < steps; t++) {
      const f = t / (steps - 1 || 1);
      const cx = Math.floor(sx + (ex - sx) * f);
      const cy = Math.floor(sy + (ey - sy) * f);
      if (cx < 0 || cx >= nx || cy < 0 || cy >= ny) continue;
      const at = cy * nx + cx;
      if (ident > grid[at]) grid[at] = ident;
    }
  }
  return { grid, nx, ny, x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 };
}

/**
 * Contrast stretch for the ramp: satellite arrays have a decent match in
 * almost every tile, so a fixed 0..100% scale collapses the interesting
 * variation (97 vs 99.5 vs 100%) into the ramp's top sliver. Map the ramp
 * over the observed spread instead — the 2nd percentile to the maximum of
 * nonempty tiles (StainedGlass-style auto scale).
 * @param {HeatBin} bin
 * @returns {{lo: number, hi: number}}
 */
export function binStretch(bin) {
  /** @type {number[]} */
  const vals = [];
  for (let i = 0; i < bin.grid.length; i++) {
    if (bin.grid[i] > 0) vals.push(bin.grid[i]);
  }
  if (vals.length === 0) return { lo: 0, hi: 1 };
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)];
  const hi = vals[vals.length - 1];
  return hi - lo < 0.005 ? { lo: Math.max(0, hi - 0.05), hi } : { lo, hi };
}

/**
 * @typedef {Object} SatMasks Occurrence-cap saturation, mapped to grid cells.
 * A cell is "saturated" when its target column — and, on self-plots, its
 * query row too — lies in a region whose k-mers were over the repeat cutoff:
 * matches there were never enumerated, so an empty cell must not read as
 * "no similarity". Painted as a diagonal hatch behind the data.
 * @property {Uint8Array} maskX per-column flags, length nx
 * @property {Uint8Array | null} maskY per-row flags (self-plots), length ny;
 *   null = cross-plot, columns alone decide
 * @property {number} r @property {number} g @property {number} b
 * @property {number} a
 */

/**
 * Mark grid cells covered by saturated intervals along one axis.
 * @param {Float64Array} intervals [start,end) pairs in bp, ascending
 * @param {number} w0 axis world start @param {number} w1 axis world end
 * @param {number} n cells along the axis
 * @returns {Uint8Array}
 */
export function buildSatMask(intervals, w0, w1, n) {
  const mask = new Uint8Array(n);
  const f = n / Math.max(w1 - w0, 1e-9);
  for (let i = 0; i < intervals.length; i += 2) {
    const c0 = Math.max(0, Math.floor((intervals[i] - w0) * f));
    const c1 = Math.min(n, Math.ceil((intervals[i + 1] - w0) * f));
    for (let c = c0; c < c1; c++) mask[c] = 1;
  }
  return mask;
}

/**
 * Paint a HeatBin into ImageData using an identity ramp (one-hue sequential
 * scale; empty cells stay transparent). The colormap is already built for
 * the active theme; its rows are 0 = forward identity ramp, 1 = reverse —
 * the heatmap uses the forward (blue) ramp as THE identity scale, stretched
 * over [lo, hi] (see binStretch).
 *
 * Empty cells in saturated regions (see SatMasks) get a diagonal hatch
 * instead of transparency; cells with data always keep their data color.
 *
 * @param {HeatBin} bin
 * @param {Uint8Array | Uint8ClampedArray} cmData 256×4-row colormap pixels (RGBA)
 * @param {number} rampRow colormap row (0 = forward identity ramp)
 * @param {number} lo ramp start identity
 * @param {number} hi ramp end identity
 * @param {SatMasks | null} [sat]
 * @returns {ImageData}
 */
export function paintHeatmap(bin, cmData, rampRow, lo, hi, sat = null) {
  const img = new ImageData(bin.nx, bin.ny);
  const denom = Math.max(hi - lo, 1e-6);
  for (let cy = 0; cy < bin.ny; cy++) {
    for (let cx = 0; cx < bin.nx; cx++) {
      const v = bin.grid[cy * bin.nx + cx];
      // ImageData rows run top-down; world y runs bottom-up — flip here so
      // the caller can draw the image directly.
      const o = ((bin.ny - 1 - cy) * bin.nx + cx) * 4;
      if (v <= 0) {
        if (
          sat && sat.maskX[cx] === 1 && (sat.maskY === null || sat.maskY[cy] === 1) &&
          ((cx + cy) & 3) < 2 // 45° stripes, two cells on / two off
        ) {
          img.data[o] = sat.r;
          img.data[o + 1] = sat.g;
          img.data[o + 2] = sat.b;
          img.data[o + 3] = sat.a;
        }
        continue;
      }
      const t = Math.min(1, Math.max(0, (v - lo) / denom));
      const texel = (rampRow * 256 + Math.round(t * 255)) * 4;
      img.data[o] = cmData[texel];
      img.data[o + 1] = cmData[texel + 1];
      img.data[o + 2] = cmData[texel + 2];
      img.data[o + 3] = 255;
    }
  }
  return img;
}

/**
 * Max identity at a world point, or 0 when empty/outside.
 * @param {HeatBin} bin @param {number} wx @param {number} wy
 */
export function heatAt(bin, wx, wy) {
  const cx = Math.floor(((wx - bin.x0) / Math.max(bin.x1 - bin.x0, 1e-9)) * bin.nx);
  const cy = Math.floor(((wy - bin.y0) / Math.max(bin.y1 - bin.y0, 1e-9)) * bin.ny);
  if (cx < 0 || cx >= bin.nx || cy < 0 || cy >= bin.ny) return 0;
  return bin.grid[cy * bin.nx + cx];
}
