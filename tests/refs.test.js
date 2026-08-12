// @ts-check
import { test, assert, assertEq } from './harness.js';
import { parseBrowserRegion, REFERENCES } from '../js/refs.js';

test('refs: genome-browser region syntax parses', () => {
  const r = parseBrowserRegion('chrX:57,820,000-60,670,000');
  assert(r !== null);
  assertEq(r.chrom, 'chrX');
  assertEq(r.start1, 57_820_000);
  assertEq(r.end1, 60_670_000);
});

test('refs: unit suffixes and decimals', () => {
  const r = parseBrowserRegion('chr8:44.2M-46.33M');
  assert(r !== null);
  assertEq(r.start1, 44_200_000);
  assertEq(r.end1, 46_330_000);
});

test('refs: interior spaces in numbers parse (shared bp grammar)', () => {
  const r = parseBrowserRegion('chrX:57 820 000-60 670 000');
  assert(r !== null);
  assertEq(r.start1, 57_820_000);
  assertEq(r.end1, 60_670_000);
});

test('refs: bare chromosome means the whole sequence', () => {
  const r = parseBrowserRegion('chr17');
  assert(r !== null);
  assertEq(r.chrom, 'chr17');
  assertEq(r.start1, null);
  assertEq(r.end1, null);
});

test('refs: names containing colons keep everything before the last colon', () => {
  const r = parseBrowserRegion('weird:name:1k-2k');
  assert(r !== null);
  assertEq(r.chrom, 'weird:name');
  assertEq(r.start1, 1000);
});

test('refs: garbage and inverted ranges return null', () => {
  assertEq(parseBrowserRegion(''), null);
  assertEq(parseBrowserRegion('chr1:5-2'), null);
  assertEq(parseBrowserRegion('chr1:0-5', ), null); // 1-based: 0 is invalid
  assertEq(parseBrowserRegion('chr1:x-y'), null);
});

test('refs: every registry preset and default region parses', () => {
  for (const ref of REFERENCES) {
    assert(parseBrowserRegion(ref.defaultRegion) !== null, `${ref.id} defaultRegion`);
    for (const p of ref.presets) {
      assert(parseBrowserRegion(p.region) !== null, `${ref.id} preset ${p.label}`);
    }
  }
});
