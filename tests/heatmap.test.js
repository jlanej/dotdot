// @ts-check
import { test, assert, assertEq } from './harness.js';
import { binIdentity, paintHeatmap, heatAt, binStretch, buildSatMask } from '../js/render/heatmap.js';

/**
 * @param {[number, number, number, number, number, number][]} rows [x, y, dx, dy, strand, identity]
 * @returns {import('../js/core/types.js').SegmentStore}
 */
function store(rows) {
  return {
    count: rows.length,
    x: Float64Array.from(rows.map((r) => r[0])),
    y: Float64Array.from(rows.map((r) => r[1])),
    dx: Float32Array.from(rows.map((r) => r[2])),
    dy: Float32Array.from(rows.map((r) => r[3])),
    strand: Uint8Array.from(rows.map((r) => r[4])),
    identity: Float32Array.from(rows.map((r) => r[5])),
  };
}

const B = { x0: 0, x1: 40, y0: 0, y1: 40 };
const BOTH = { showFwd: true, showRev: true };

test('heatmap: forward diagonal paints the diagonal cells', () => {
  const bin = binIdentity(store([[0, 0, 40, 40, 0, 0.9]]), B, 4, 4, BOTH);
  for (let c = 0; c < 4; c++) assert(Math.abs(bin.grid[c * 4 + c] - 0.9) < 1e-6, `cell ${c},${c}`);
  assertEq(bin.grid[0 * 4 + 3], 0); // off-diagonal untouched
});

test('heatmap: reverse segment paints the anti-diagonal', () => {
  // Inset from the grid edges: cells are half-open, so a point exactly on
  // the max edge belongs to the (out-of-range) next cell.
  const bin = binIdentity(store([[2, 2, 36, 36, 1, 0.8]]), B, 4, 4, BOTH);
  assert(bin.grid[3 * 4 + 0] > 0, 'top-left end');
  assert(bin.grid[0 * 4 + 3] > 0, 'bottom-right end');
  assertEq(bin.grid[0 * 4 + 0], 0);
});

test('heatmap: strand filters choose what is binned', () => {
  const s = store([[0, 0, 40, 40, 1, 0.8]]);
  const bin = binIdentity(s, B, 4, 4, { showFwd: true, showRev: false });
  let sum = 0;
  for (const v of bin.grid) sum += v;
  assertEq(sum, 0);
});

test('heatmap: max identity wins per cell; out-of-bounds segments skip', () => {
  const s = store([
    [0, 0, 10, 10, 0, 0.5],
    [0, 0, 10, 10, 0, 0.95],
    [1000, 1000, 10, 10, 0, 1.0], // outside the bounds
  ]);
  const bin = binIdentity(s, B, 4, 4, BOTH);
  assert(Math.abs(bin.grid[0] - 0.95) < 1e-6);
});

test('heatmap: heatAt reads the cell under a world point', () => {
  const bin = binIdentity(store([[0, 0, 40, 40, 0, 0.9]]), B, 4, 4, BOTH);
  assert(heatAt(bin, 5, 5) > 0);
  assertEq(heatAt(bin, 5, 35), 0);
  assertEq(heatAt(bin, -5, 5), 0);
});

test('heatmap: binStretch spans the observed tile range', () => {
  const s = store([
    [0, 0, 10, 10, 0, 0.92],
    [20, 20, 10, 10, 0, 0.99],
  ]);
  const bin = binIdentity(s, B, 4, 4, BOTH);
  const r = binStretch(bin);
  assert(Math.abs(r.lo - 0.92) < 1e-6, `lo ${r.lo}`);
  assert(Math.abs(r.hi - 0.99) < 1e-6, `hi ${r.hi}`);
  // A near-uniform grid still gets a usable (widened) ramp.
  const flat = binIdentity(store([[0, 0, 40, 40, 0, 1.0]]), B, 4, 4, BOTH);
  const rf = binStretch(flat);
  assert(rf.hi - rf.lo >= 0.005, 'ramp widened for flat data');
});

test('heatmap: paint flips rows and leaves empty cells transparent', () => {
  const bin = binIdentity(store([[0, 0, 8, 8, 0, 1]]), { x0: 0, x1: 40, y0: 0, y1: 40 }, 4, 4, BOTH);
  // Minimal colormap: 2 rows × 256 texels; row 0 red ramp.
  const cm = new Uint8ClampedArray(2 * 256 * 4);
  for (let i = 0; i < 256; i++) {
    cm[i * 4] = 200;
    cm[i * 4 + 3] = 255;
  }
  const img = paintHeatmap(bin, cm, 0, 0, 1);
  // World cell (0,0) is bottom-left → image row ny-1.
  const o = ((4 - 1) * 4 + 0) * 4;
  assertEq(img.data[o], 200);
  assertEq(img.data[o + 3], 255);
  assertEq(img.data[3], 0); // top-left image cell = world (0,3): empty, transparent
});

test('heatmap: buildSatMask maps bp intervals onto grid columns', () => {
  const m = buildSatMask(Float64Array.from([10, 20]), 0, 40, 4);
  assertEq(Array.from(m).join(','), '0,1,0,0');
  const all = buildSatMask(Float64Array.from([0, 40]), 0, 40, 4);
  assertEq(Array.from(all).join(','), '1,1,1,1');
  // Outside the visible window: nothing marked.
  assertEq(Array.from(buildSatMask(Float64Array.from([100, 120]), 0, 40, 4)).join(','), '0,0,0,0');
});

test('heatmap: saturation hatches empty capped cells; data always wins', () => {
  const bin = binIdentity(store([[0, 0, 10, 10, 0, 0.9]]), B, 4, 4, BOTH);
  const cm = new Uint8Array(256 * 4 * 4).fill(255);
  const sat = { maskX: Uint8Array.from([1, 1, 0, 0]), maskY: null, r: 100, g: 100, b: 100, a: 200 };
  const img = paintHeatmap(bin, cm, 0, 0, 1, sat);
  /** @param {number} cx @param {number} cy */
  const px = (cx, cy) => ((4 - 1 - cy) * 4 + cx) * 4;
  // Data cell (0,0): the colormap color, full alpha — never the hatch.
  assertEq(img.data[px(0, 0) + 3], 255);
  assertEq(img.data[px(0, 0)], 255);
  // Empty cell (0,1): saturated column, on-stripe ((0+1)&3 < 2) → hatch color.
  assertEq(img.data[px(0, 1) + 3], 200);
  assertEq(img.data[px(0, 1)], 100);
  // Empty cell (1,2): saturated column but off-stripe ((1+2)&3 = 3) → clear.
  assertEq(img.data[px(1, 2) + 3], 0);
  // Empty cell (2,2): stripe would hit ((2+2)&3 = 0) but column unsaturated → clear.
  assertEq(img.data[px(2, 2) + 3], 0);
  // Without sat masks nothing hatches.
  const plain = paintHeatmap(bin, cm, 0, 0, 1);
  assertEq(plain.data[px(0, 1) + 3], 0);
});

test('heatmap: self-plot masks hatch only where both axes are capped', () => {
  const bin = binIdentity(store([]), B, 4, 4, BOTH); // all empty
  const cm = new Uint8Array(256 * 4 * 4).fill(255);
  const sat = {
    maskX: Uint8Array.from([1, 1, 1, 1]),
    maskY: Uint8Array.from([1, 0, 0, 0]),
    r: 100, g: 100, b: 100, a: 200,
  };
  const img = paintHeatmap(bin, cm, 0, 0, 1, sat);
  /** @param {number} cx @param {number} cy */
  const px = (cx, cy) => ((4 - 1 - cy) * 4 + cx) * 4;
  // Row 0 is capped on both axes: on-stripe cell (1,0) hatches.
  assertEq(img.data[px(1, 0) + 3], 200);
  // Row 1 is not: on-stripe cell (0,1) stays clear.
  assertEq(img.data[px(0, 1) + 3], 0);
});
