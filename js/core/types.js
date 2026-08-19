// @ts-check
/**
 * Shared typedefs plus the one authoritative definition of the SegmentStore
 * field list: every allocate / copy / transfer / filter of segment columns
 * goes through the helpers below, so adding a field is a change in exactly
 * one file.
 */
import { F64Vec, F32Vec, U8Vec } from './vec.js';

/**
 * One axis of the plot: an ordered set of sequences laid end to end in a
 * single global bp coordinate space.
 * @typedef {Object} AxisCatalog
 * @property {string[]} names
 * @property {Float64Array} starts Global start of each sequence plus a final
 *   sentinel equal to `total` (length = names.length + 1).
 * @property {number} total
 * @property {Float64Array} [offsets] Optional display offset per record: the
 *   true genomic coordinate of local position 0 (reference-region slices).
 *   Affects coordinate display and region parsing only, never geometry.
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
 * Index-side composition summary for the stats popup (alignment-free plots
 * only): the k-mer occurrence spectrum plus the knobs that shaped it.
 * @typedef {Object} KmerStats
 * @property {number} k
 * @property {number} stride
 * @property {number} qSample
 * @property {number} maxOcc effective repeat cutoff, original-occurrence units
 * @property {number} distinct distinct k-mers in the index
 * @property {number} entries index entries (post-stride positions)
 * @property {Float64Array} occCount distinct k-mers per occurrence class
 *   (1..1023 exact; 1024 = ≥1024)
 * @property {Float64Array} saturated merged target [start,end) pairs where
 *   most k-mers were over the repeat cutoff — matches there were never
 *   enumerated (see saturatedIntervals in core/kmer.js)
 * @property {{tileBp:number, mult:Float32Array, uniqFrac:Float32Array}} [profile]
 *   per-tile k-mer copy-number estimate + unique fraction along the target
 *   (multiplicityProfile; absent on refine-window results)
 */

/**
 * @typedef {Object} PlotData
 * @property {AxisCatalog} target
 * @property {AxisCatalog} query
 * @property {SegmentStore} segments
 * @property {'kmer'|'paf'} source
 * @property {{elapsedMs:number, note?:string, skippedLines?:number, identMin:number, kmer?:KmerStats, merged?:boolean}} stats
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

/**
 * Growable segment-vector bundle for the matchers.
 * @param {number} [cap]
 * @param {boolean} [withEdge] track chunk-edge flags (pool workers)
 * @returns {import('./kmer.js').SegmentVecs}
 */
export function newSegmentVecs(cap = 1 << 16, withEdge = false) {
  /** @type {import('./kmer.js').SegmentVecs} */
  const v = {
    x: new F64Vec(cap),
    y: new F64Vec(cap),
    dx: new F32Vec(cap),
    dy: new F32Vec(cap),
    strand: new U8Vec(cap),
    identity: new F32Vec(cap),
  };
  if (withEdge) v.edge = new U8Vec(cap);
  return v;
}

/**
 * Finalize a vector bundle into a right-sized SegmentStore.
 * @param {import('./kmer.js').SegmentVecs} v
 * @returns {SegmentStore}
 */
export function vecsToSegments(v) {
  return {
    count: v.x.n,
    x: v.x.done(),
    y: v.y.done(),
    dx: v.dx.done(),
    dy: v.dy.done(),
    strand: v.strand.done(),
    identity: v.identity.done(),
  };
}

/**
 * @param {number} n
 * @returns {SegmentStore}
 */
export function allocSegments(n) {
  return {
    count: n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    dx: new Float32Array(n),
    dy: new Float32Array(n),
    strand: new Uint8Array(n),
    identity: new Float32Array(n),
  };
}

/**
 * Copy one segment row.
 * @param {SegmentStore} dst @param {number} j
 * @param {SegmentStore} src @param {number} i
 */
export function copySegmentRow(dst, j, src, i) {
  dst.x[j] = src.x[i];
  dst.y[j] = src.y[i];
  dst.dx[j] = src.dx[i];
  dst.dy[j] = src.dy[i];
  dst.strand[j] = src.strand[i];
  dst.identity[j] = src.identity[i];
}

/**
 * Bulk-copy `src` (exact-sized arrays) into `dst` starting at row `at`.
 * @param {SegmentStore} dst @param {number} at @param {SegmentStore} src
 */
export function blitSegments(dst, at, src) {
  dst.x.set(src.x, at);
  dst.y.set(src.y, at);
  dst.dx.set(src.dx, at);
  dst.dy.set(src.dy, at);
  dst.strand.set(src.strand, at);
  dst.identity.set(src.identity, at);
}

/**
 * The transfer list for posting a store across a worker boundary.
 * @param {SegmentStore} s
 * @returns {Transferable[]}
 */
export function segmentBuffers(s) {
  return [s.x.buffer, s.y.buffer, s.dx.buffer, s.dy.buffer, s.strand.buffer, s.identity.buffer];
}

/**
 * The one display-visibility predicate, mirroring the GL shader's uniform
 * filters — hover picking and SVG export must agree with the screen.
 * @param {SegmentStore} s @param {number} i
 * @param {{showFwd:boolean, showRev:boolean, minIdentity:number, minLenBp:number}} opts
 */
export function segmentVisible(s, i, opts) {
  // The shader is epsilon-permissive at both thresholds (float32 identities
  // land just under round slider values; length compares carry +0.5 bp) —
  // mirror it exactly, or a segment can be drawn on screen yet excluded
  // from hover picking and SVG export.
  return (
    (s.strand[i] === 0 ? opts.showFwd : opts.showRev) &&
    s.identity[i] + 1e-6 >= opts.minIdentity &&
    s.dx[i] + 0.5 >= opts.minLenBp
  );
}
