// @ts-check
import { test, assert, assertEq } from './harness.js';
import { SegmentGrid, pointSegDist } from '../js/core/grid.js';
import { View } from '../js/core/transform.js';

/** Build a tiny store: two forward diagonals and one reverse. */
function makeStore() {
  return {
    count: 3,
    x: new Float64Array([100, 600, 300]),
    y: new Float64Array([100, 600, 700]),
    dx: new Float32Array([200, 150, 100]),
    dy: new Float32Array([200, 150, 100]),
    strand: new Uint8Array([0, 0, 1]),
    identity: new Float32Array([1, 1, 1]),
  };
}

test('grid: query finds crossing segments exactly once', () => {
  const grid = new SegmentGrid(makeStore(), 1000, 1000);
  /** @type {number[]} */
  const hits = [];
  grid.query(0, 0, 1000, 1000, (i) => hits.push(i));
  hits.sort();
  assertEq(hits.length, 3);
  assertEq(hits[0], 0);
  assertEq(hits[2], 2);
});

test('grid: localized query excludes far segments', () => {
  const grid = new SegmentGrid(makeStore(), 1000, 1000);
  /** @type {number[]} */
  const hits = [];
  grid.query(90, 90, 160, 160, (i) => hits.push(i));
  assertEq(hits.length, 1);
  assertEq(hits[0], 0);
});

test('grid: nearest picks the segment under the cursor', () => {
  const store = makeStore();
  const grid = new SegmentGrid(store, 1000, 1000);
  const view = new View(1000, 1000);
  view.fit(500, 500, false, 0);
  // world (200,200) sits on segment 0's diagonal
  const px = view.worldToPxX(200, 500);
  const py = view.worldToPxY(200, 500);
  const hit = grid.nearest(view, 500, 500, px, py, 6);
  assert(hit !== null, 'expected a hit');
  assertEq(hit.index, 0);
  assert(hit.distPx < 1.5, `distance too large: ${hit.distPx}`);
});

test('grid: nearest respects the reverse-strand anti-diagonal', () => {
  const store = makeStore();
  const grid = new SegmentGrid(store, 1000, 1000);
  const view = new View(1000, 1000);
  view.fit(500, 500, false, 0);
  // reverse segment 2 runs (300,800) -> (400,700); midpoint (350, 750)
  const px = view.worldToPxX(350, 500);
  const py = view.worldToPxY(750, 500);
  const hit = grid.nearest(view, 500, 500, px, py, 6);
  assert(hit !== null && hit.index === 2, `expected segment 2, got ${hit && hit.index}`);
});

test('grid: nearest returns null away from data', () => {
  const grid = new SegmentGrid(makeStore(), 1000, 1000);
  const view = new View(1000, 1000);
  view.fit(500, 500, false, 0);
  assertEq(grid.nearest(view, 500, 500, view.worldToPxX(900, 500), view.worldToPxY(100, 500), 6), null);
});

test('grid: pointSegDist basics', () => {
  assertEq(pointSegDist(0, 5, 0, 0, 10, 0), 5);
  assertEq(pointSegDist(-3, 0, 0, 0, 10, 0), 3);
  assertEq(pointSegDist(5, 0, 0, 0, 10, 0), 0);
});

test('grid: empty store survives', () => {
  const empty = {
    count: 0,
    x: new Float64Array(0),
    y: new Float64Array(0),
    dx: new Float32Array(0),
    dy: new Float32Array(0),
    strand: new Uint8Array(0),
    identity: new Float32Array(0),
  };
  const grid = new SegmentGrid(empty, 1000, 1000);
  let n = 0;
  grid.query(0, 0, 1000, 1000, () => n++);
  assertEq(n, 0);
});
