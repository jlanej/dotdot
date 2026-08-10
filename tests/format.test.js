// @ts-check
import { test, assertEq } from './harness.js';
import { formatBp, formatTick, formatInt, formatCount } from '../js/render/format.js';

test('format: formatBp picks sensible units', () => {
  assertEq(formatBp(532), '532 bp');
  assertEq(formatBp(12_400), '12.4 kb');
  assertEq(formatBp(1_280_000), '1.28 Mb');
  assertEq(formatBp(3_100_000_000), '3.1 Gb');
});

test('format: tick labels share step-derived decimals', () => {
  assertEq(formatTick(24_500_000, 500_000), '24.5 Mb');
  assertEq(formatTick(0, 500_000), '0');
  assertEq(formatTick(2_000, 1_000), '2 kb');
});

test('format: deep zoom on huge coordinates falls back to exact positions', () => {
  // 20 bp steps at ~3 Gb would collapse to identical "2.950 Gb" labels
  assertEq(formatTick(2_949_999_860, 20), '2,949,999,860');
  assertEq(formatTick(2_949_999_880, 20), '2,949,999,880');
});

test('format: counts', () => {
  assertEq(formatInt(1234567), '1,234,567');
  assertEq(formatCount(87), '87');
  assertEq(formatCount(1_240_000), '1.24 M');
});
