// @ts-check
import { test, assert, assertEq } from './harness.js';
import { buildViewHash, parseViewHash, writeMatchParams, readMatchParams } from '../js/core/share.js';
import { parseBp } from '../js/core/region.js';

test('share: view state round-trips through the hash', () => {
  /** @type {import('../js/core/share.js').ViewState} */
  const v = {
    x0: 1_885_000,
    x1: 1_912_000,
    y0: 4_383_406,
    y1: 4_410_406,
    len: '2kb',
    ident: 0.95,
    draw: 'heat',
    col: 2,
    fwd: true,
    rev: false,
    auto: true,
  };
  const parsed = parseViewHash(buildViewHash(v));
  assert(parsed !== null);
  assertEq(parsed.x0, v.x0);
  assertEq(parsed.x1, v.x1);
  assertEq(parsed.y0, v.y0);
  assertEq(parsed.y1, v.y1);
  assertEq(parsed.len, '2kb');
  assertEq(parsed.ident, 0.95);
  assertEq(parsed.draw, 'heat');
  assertEq(parsed.col, 2);
  assertEq(parsed.fwd, true);
  assertEq(parsed.rev, false);
  assertEq(parsed.auto, true);
});

test('share: defaults stay out of the hash and come back as defaults', () => {
  const hash = buildViewHash({
    x0: 0, x1: 100, y0: 0, y1: 200,
    len: 'off', ident: 0, draw: 'seg', col: 0, fwd: true, rev: true, auto: false,
  });
  assertEq(hash, '#v=0-100:0-200');
  const parsed = parseViewHash(hash);
  assert(parsed !== null);
  assertEq(parsed.len, 'off');
  assertEq(parsed.ident, 0);
  assertEq(parsed.draw, 'seg');
  assertEq(parsed.col, 0);
  assertEq(parsed.fwd, true);
  assertEq(parsed.rev, true);
  assertEq(parsed.auto, false);
});

test('share: malformed or missing viewports parse to null', () => {
  assertEq(parseViewHash(''), null);
  assertEq(parseViewHash('#'), null);
  assertEq(parseViewHash('#len=2kb'), null);
  assertEq(parseViewHash('#v=abc'), null);
  assertEq(parseViewHash('#v=100-50:0-10'), null); // inverted x
  assertEq(parseViewHash('#v=0-100:9-9'), null); // empty y
});

test('share: unknown keys are ignored, partial settings tolerated', () => {
  const parsed = parseViewHash('#v=5-15:5-15&future=thing&ident=nonsense');
  assert(parsed !== null);
  assertEq(parsed.ident, 0); // nonsense clamps to default
  assertEq(parsed.draw, 'seg');
});

test('share: default match options write no params at all', () => {
  const q = new URLSearchParams();
  writeMatchParams(q, { k: 15, maxGap: 64, maxOcc: 200, minRunLen: 0, sample: 'auto', budgetX: 1 });
  assertEq(q.toString(), '');
});

test('share: every non-default option round-trips through the grammar', () => {
  const q = new URLSearchParams();
  writeMatchParams(
    q,
    {
      k: 21,
      maxGap: 256,
      maxOcc: Infinity,
      minRunLen: 300,
      sample: 'off',
      exactMaxBp: 512_000_000,
      budgetX: Infinity,
      maxSegments: 32_000_000,
    },
    1024,
  );
  const r = readMatchParams(q, parseBp);
  assertEq(r.k, '21');
  assertEq(r.gap, '256');
  assertEq(r.occ, 'off');
  assertEq(r.minrun, '300');
  assertEq(r.sample, 'off 512M'); // the raised RAM ceiling survives the trip
  assertEq(r.budget, 'off');
  assertEq(r.anitiles, '1024');
  assertEq(r.wall, 32_000_000);
});

test('share: numeric budget re-suffixes as a multiplier; words pass through', () => {
  const q = new URLSearchParams('budget=4');
  assertEq(readMatchParams(q, parseBp).budget, '4×');
  const q2 = new URLSearchParams();
  writeMatchParams(q2, { k: 15, maxGap: 64, maxOcc: 200, minRunLen: 0, sample: 'auto', budgetX: 4 });
  assertEq(readMatchParams(q2, parseBp).budget, '4×');
});

test('share: the wall param only raises — lowerings and garbage are ignored', () => {
  assertEq(readMatchParams(new URLSearchParams('wall=32M'), parseBp).wall, 32_000_000);
  assertEq(readMatchParams(new URLSearchParams('wall=8M'), parseBp).wall, 0); // below the 16M default
  assertEq(readMatchParams(new URLSearchParams('wall=999M'), parseBp).wall, 64_000_000); // hard clamp
  assertEq(readMatchParams(new URLSearchParams('wall=banana'), parseBp).wall, 0);
  assertEq(readMatchParams(new URLSearchParams(), parseBp).wall, 0);
});

test('share: numbered sampling and finite caps write plainly', () => {
  const q = new URLSearchParams();
  writeMatchParams(q, { k: 15, maxGap: 64, maxOcc: 1000, minRunLen: 0, sample: 8, budgetX: 1 });
  const r = readMatchParams(q, parseBp);
  assertEq(r.occ, '1000');
  assertEq(r.sample, '8');
  assertEq(r.k, undefined); // defaults stay absent
});
