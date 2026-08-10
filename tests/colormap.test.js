// @ts-check
import { test, assert, assertClose } from './harness.js';
import { srgbToOklab, oklchToSrgb, hexToRgb, rgbToHex, buildColormap } from '../js/render/colormap.js';

test('colormap: oklab roundtrip on palette anchors', () => {
  for (const hex of ['#2a78d6', '#eb6834', '#0d366b', '#fcfcfb']) {
    const [r, g, b] = hexToRgb(hex);
    const [L, a, bb] = srgbToOklab(r, g, b);
    const C = Math.hypot(a, bb);
    const h = Math.atan2(bb, a);
    const back = oklchToSrgb(L, C, h);
    assertClose(back[0], r, 0.005, `${hex} r`);
    assertClose(back[1], g, 0.005, `${hex} g`);
    assertClose(back[2], b, 0.005, `${hex} b`);
  }
});

test('colormap: hex helpers roundtrip', () => {
  assertClose(hexToRgb('#ff8000')[1], 128 / 255, 1e-6);
  assert(rgbToHex([1, 0.50196, 0]) === '#ff8000');
});

test('colormap: light-mode ramps darken with identity', () => {
  const cm = buildColormap('light');
  for (const row of [0, 1]) {
    const first = srgbToOklab(cm.data[row * 1024] / 255, cm.data[row * 1024 + 1] / 255, cm.data[row * 1024 + 2] / 255)[0];
    const o = (row * 256 + 255) * 4;
    const last = srgbToOklab(cm.data[o] / 255, cm.data[o + 1] / 255, cm.data[o + 2] / 255)[0];
    assert(first > last + 0.2, `row ${row}: L ${first} -> ${last}`);
  }
});

test('colormap: dark-mode ramps brighten with identity', () => {
  const cm = buildColormap('dark');
  for (const row of [0, 1]) {
    const first = srgbToOklab(cm.data[row * 1024] / 255, cm.data[row * 1024 + 1] / 255, cm.data[row * 1024 + 2] / 255)[0];
    const o = (row * 256 + 255) * 4;
    const last = srgbToOklab(cm.data[o] / 255, cm.data[o + 1] / 255, cm.data[o + 2] / 255)[0];
    assert(last > first + 0.2, `row ${row}: L ${first} -> ${last}`);
  }
});

test('colormap: ramp lightness is monotone', () => {
  for (const mode of /** @type {const} */ (['light', 'dark'])) {
    const cm = buildColormap(mode);
    for (const row of [0, 1]) {
      let prev = null;
      for (let i = 0; i < 256; i += 8) {
        const o = (row * 256 + i) * 4;
        const L = srgbToOklab(cm.data[o] / 255, cm.data[o + 1] / 255, cm.data[o + 2] / 255)[0];
        if (prev !== null) {
          const step = mode === 'light' ? prev - L : L - prev;
          assert(step > -0.005, `${mode} row ${row} non-monotone at ${i}`);
        }
        prev = L;
      }
    }
  }
});
