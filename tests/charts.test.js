// @ts-check
import { test, assert, assertEq, assertArrayEq } from './harness.js';
import {
  ladderBins,
  ladderLabels,
  segmentDistributions,
  occupancyBins,
  groupedBarsSVG,
} from '../js/render/charts.js';

test('charts: ladderBins walks the 1-2-5 ladder over [lo, hi]', () => {
  assertArrayEq(ladderBins(10, 5000), [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]);
  assertArrayEq(ladderBins(30, 400), [50, 100, 200, 500]);
  assertArrayEq(ladderBins(1, 1), [1]);
  assertEq(ladderLabels([2000])[0], '2 kb');
});

test('charts: segmentDistributions bins lengths and identity by strand', () => {
  const s = {
    count: 4,
    x: new Float64Array(4),
    y: new Float64Array(4),
    dx: Float32Array.from([15, 150, 150, 3000]),
    dy: Float32Array.from([15, 150, 150, 3000]),
    strand: Uint8Array.from([0, 0, 1, 1]),
    identity: Float32Array.from([1, 0.875, 1, 0.75]), // float32-exact values
  };
  const d = segmentDistributions(s);
  assert(d !== null);
  assertArrayEq(d.lengths.edges, [20, 50, 100, 200, 500, 1000, 2000, 5000]);
  assertEq(d.lengths.fwd[0], 1); // 15 ≤ 20
  assertEq(d.lengths.fwd[3], 1); // 150 ≤ 200
  assertEq(d.lengths.rev[3], 1);
  assertEq(d.lengths.rev[7], 1); // 3000 ≤ 5000
  // Identity: lo = 0.75, 40 bins.
  assertEq(d.identity.lo, 0.75);
  const nI = d.identity.fwd.length;
  assertEq(nI, 40);
  assertEq(d.identity.rev[0], 1); // 0.75 sits at the floor
  // 0.875 lands mid-range; allow the float-division boundary either way.
  assertEq(d.identity.fwd[19] + d.identity.fwd[20], 1);
  assertEq(d.identity.fwd[nI - 1] + d.identity.rev[nI - 1], 2); // both 1.0s clamp into the top bin
});

test('charts: segmentDistributions on an empty store is null', () => {
  const empty = {
    count: 0,
    x: new Float64Array(0),
    y: new Float64Array(0),
    dx: new Float32Array(0),
    dy: new Float32Array(0),
    strand: new Uint8Array(0),
    identity: new Float32Array(0),
  };
  assertEq(segmentDistributions(empty), null);
});

test('charts: occupancyBins classes and the ≥1024 lump', () => {
  const occ = new Float64Array(1025);
  occ[1] = 5;
  occ[2] = 3;
  occ[4] = 2;
  occ[1024] = 7;
  const bins = occupancyBins(occ);
  assertEq(bins.length, 12);
  assertEq(bins[0].label, '1');
  assertEq(bins[0].count, 5);
  assertEq(bins[1].count, 3);
  assertEq(bins[2].label, '3–4');
  assertEq(bins[2].count, 2);
  assertEq(bins[11].label, '≥1024');
  assertEq(bins[11].count, 7);
  assertEq(bins[5].count, 0);
});

test('charts: groupedBarsSVG draws one rect per nonzero value', () => {
  const svg = groupedBarsSVG({
    binLabels: ['a', 'b', 'c'],
    series: [
      { name: 'fwd', color: '#2a78d6', values: [3, 0, 10] },
      { name: 'rev', color: '#eb6834', values: [0, 1, 0] },
    ],
  });
  assert(svg.startsWith('<svg'));
  assertEq((svg.match(/<rect /g) || []).length, 3);
  assert(svg.includes('var(--grid)'), 'theme tokens for the grid');
  assert(svg.includes('#2a78d6'), 'series colors pass through');
});
