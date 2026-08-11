// @ts-check
import { test, assertEq } from './harness.js';
import { locate, bandsInRange } from '../js/core/catalog.js';

const cat = {
  names: ['chr1', 'chr2', 'chr3'],
  starts: new Float64Array([0, 100, 350, 500]),
  total: 500,
};

test('catalog: locate finds the right band and local coord', () => {
  assertEq(locate(cat, 0)?.name, 'chr1');
  assertEq(locate(cat, 99)?.name, 'chr1');
  assertEq(locate(cat, 100)?.name, 'chr2');
  assertEq(locate(cat, 100)?.local, 0);
  assertEq(locate(cat, 349)?.local, 249);
  assertEq(locate(cat, 499)?.name, 'chr3');
  assertEq(locate(cat, 500), null);
  assertEq(locate(cat, -1), null);
});

test('catalog: locate adds display offsets when present', () => {
  const withOff = {
    names: ['chrX'],
    starts: new Float64Array([0, 1000]),
    total: 1000,
    offsets: new Float64Array([57_820_000]),
  };
  assertEq(locate(withOff, 0)?.local, 57_820_000);
  assertEq(locate(withOff, 999)?.local, 57_820_999);
});

test('catalog: bandsInRange clips to visible window', () => {
  const all = bandsInRange(cat, -50, 600);
  assertEq(all.first, 0);
  assertEq(all.last, 2);
  const mid = bandsInRange(cat, 120, 340);
  assertEq(mid.first, 1);
  assertEq(mid.last, 1);
  const cross = bandsInRange(cat, 90, 110);
  assertEq(cross.first, 0);
  assertEq(cross.last, 1);
  const empty = bandsInRange(cat, 600, 700);
  assertEq(empty.last < empty.first, true);
});
