// @ts-check
import { test, assert, assertClose } from './harness.js';
import { View } from '../js/core/transform.js';

test('transform: fit centers the domain', () => {
  const v = new View(1000, 2000);
  v.fit(500, 500, false, 0);
  assertClose(v.cx, 500, 1e-9);
  assertClose(v.cy, 1000, 1e-9);
  assertClose(v.bppX, 2, 1e-9);
  assertClose(v.bppY, 4, 1e-9);
});

test('transform: world<->px roundtrip', () => {
  const v = new View(5e8, 3e8);
  v.fit(800, 600, false);
  for (const wx of [0, 123456789, 5e8]) {
    assertClose(v.pxToWorldX(v.worldToPxX(wx, 800), 800), wx, 1e-3);
  }
  for (const wy of [0, 98765432, 3e8]) {
    assertClose(v.pxToWorldY(v.worldToPxY(wy, 600), 600), wy, 1e-3);
  }
});

test('transform: y axis is flipped (world up = screen up)', () => {
  const v = new View(100, 100);
  v.fit(100, 100, false, 0);
  assert(v.worldToPxY(0, 100) > v.worldToPxY(100, 100), 'low coord at bottom');
});

test('transform: zoomAt keeps the cursor world point fixed', () => {
  const v = new View(1e6, 1e6);
  v.fit(700, 500, false);
  const px = 123;
  const py = 456;
  const wx = v.pxToWorldX(px, 700);
  const wy = v.pxToWorldY(py, 500);
  v.zoomAt(px, py, 3.7, 700, 500, 'both');
  assertClose(v.pxToWorldX(px, 700), wx, 1e-6);
  assertClose(v.pxToWorldY(py, 500), wy, 1e-6);
});

test('transform: axis-constrained zoom leaves the other axis alone', () => {
  const v = new View(1e6, 1e6);
  v.fit(700, 500, false);
  const bppY = v.bppY;
  v.zoomAt(350, 250, 2, 700, 500, 'x');
  assertClose(v.bppY, bppY, 1e-12);
});

test('transform: panPx follows the pointer', () => {
  const v = new View(1e6, 1e6);
  v.fit(700, 500, false);
  const wx = v.pxToWorldX(100, 700);
  const wy = v.pxToWorldY(100, 500);
  v.panPx(50, -30);
  assertClose(v.pxToWorldX(150, 700), wx, 1e-6);
  assertClose(v.pxToWorldY(70, 500), wy, 1e-6);
});

test('transform: fitRect frames the rect', () => {
  const v = new View(1e6, 1e6);
  v.fit(800, 800, false);
  v.fitRect(1000, 2000, 51000, 27000, 800, 800);
  assertClose(v.pxToWorldX(0, 800), 1000, 1);
  assertClose(v.pxToWorldX(800, 800), 51000, 1);
  assertClose(v.pxToWorldY(800, 800), 2000, 1);
  assertClose(v.pxToWorldY(0, 800), 27000, 1);
});

test('transform: zoom clamps at 512 px per bp', () => {
  const v = new View(1e6, 1e6);
  v.fit(500, 500, false);
  for (let i = 0; i < 100; i++) v.zoomAt(250, 250, 10, 500, 500, 'both');
  assert(v.bppX >= 1 / 512 - 1e-12, `bppX over-zoomed: ${v.bppX}`);
});
