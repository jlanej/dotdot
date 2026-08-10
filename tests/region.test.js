// @ts-check
import { test, assert, assertEq, assertClose } from './harness.js';
import { parseBp, resolveRegion } from '../js/core/region.js';

const cat = {
  names: ['chr17', 'tig00042'],
  starts: new Float64Array([0, 84_276_897, 90_276_897]),
  total: 90_276_897,
};

test('region: parseBp units and separators', () => {
  assertEq(parseBp('45M'), 45e6);
  assertEq(parseBp('46.5 Mb'), 46.5e6);
  assertEq(parseBp('2.5kb'), 2500);
  assertEq(parseBp('1,234,567'), 1234567);
  assertEq(parseBp('987'), 987);
  assertEq(parseBp('1.2G'), 1.2e9);
  assert(Number.isNaN(parseBp('chr17')), 'names are not numbers');
  assert(Number.isNaN(parseBp('')), 'empty is NaN');
});

test('region: bare sequence name resolves to the whole band', () => {
  const r = resolveRegion('chr17', cat);
  assert(r !== null);
  assertEq(r.x0, 0);
  assertEq(r.x1, 84_276_897);
  const r2 = resolveRegion('TIG00042', cat); // case-insensitive
  assert(r2 !== null);
  assertEq(r2.x0, 84_276_897);
});

test('region: name with range offsets into the band', () => {
  const r = resolveRegion('chr17:45M-46.5M', cat);
  assert(r !== null);
  assertClose(r.x0, 45e6, 1e-6);
  assertClose(r.x1, 46.5e6, 1e-6);
  const r2 = resolveRegion('tig00042:1M-2M', cat);
  assert(r2 !== null);
  assertClose(r2.x0, 84_276_897 + 1e6, 1e-6);
});

test('region: nameless range uses global coordinates', () => {
  const r = resolveRegion('45M-46M', cat);
  assert(r !== null);
  assertClose(r.x0, 45e6, 1e-6);
});

test('region: comma-separated coordinates', () => {
  const r = resolveRegion('chr17:100,000-250,000', cat);
  assert(r !== null);
  assertEq(r.x0, 100_000);
  assertEq(r.x1, 250_000);
});

test('region: clamps to sequence length', () => {
  const r = resolveRegion('tig00042:5M-99M', cat);
  assert(r !== null);
  assertEq(r.x1, 90_276_897);
});

test('region: garbage returns null', () => {
  assertEq(resolveRegion('chrUnknown:1-2', cat), null);
  assertEq(resolveRegion('chr17:5M-4M', cat), null);
  assertEq(resolveRegion('chr17:x-y', cat), null);
  assertEq(resolveRegion('', cat), null);
});
