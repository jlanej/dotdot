// @ts-check
import { test, assert, assertEq } from './harness.js';
import { buildViewHash, parseViewHash } from '../js/core/share.js';

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
