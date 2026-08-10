// @ts-check
/**
 * Shared JSDoc typedefs. This module has no runtime exports of substance; it
 * exists so every other module can `@typedef {import('./types.js').X} X`.
 */

/**
 * One axis of the plot: an ordered set of sequences laid end to end in a
 * single global bp coordinate space.
 * @typedef {Object} AxisCatalog
 * @property {string[]} names
 * @property {Float64Array} starts Global start of each sequence plus a final
 *   sentinel equal to `total` (length = names.length + 1).
 * @property {number} total
 */

/**
 * Column-oriented store of plot segments (matches / alignments).
 * `x` is the global target-axis start; `y` is the *minimum* query coordinate.
 * Forward segments run (x, y) -> (x+dx, y+dy); reverse segments run
 * (x, y+dy) -> (x+dx, y).
 * @typedef {Object} SegmentStore
 * @property {number} count
 * @property {Float64Array} x
 * @property {Float64Array} y
 * @property {Float32Array} dx
 * @property {Float32Array} dy
 * @property {Uint8Array} strand 0 = forward, 1 = reverse
 * @property {Float32Array} identity 0..1
 */

/**
 * @typedef {Object} PlotData
 * @property {AxisCatalog} target
 * @property {AxisCatalog} query
 * @property {SegmentStore} segments
 * @property {'kmer'|'paf'} source
 * @property {{elapsedMs:number, note?:string, skippedLines?:number, identMin:number}} stats
 */

/**
 * Screen-space endpoints helper: writes [x0, y0, x1, y1] for segment i into
 * `out` (world bp coords, strand-aware).
 * @param {SegmentStore} s
 * @param {number} i
 * @param {Float64Array} out length >= 4
 */
export function segmentEndpoints(s, i, out) {
  const x = s.x[i];
  const y = s.y[i];
  const dx = s.dx[i];
  const dy = s.dy[i];
  if (s.strand[i] === 0) {
    out[0] = x;
    out[1] = y;
    out[2] = x + dx;
    out[3] = y + dy;
  } else {
    out[0] = x;
    out[1] = y + dy;
    out[2] = x + dx;
    out[3] = y;
  }
}

export {};
