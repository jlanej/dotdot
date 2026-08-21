// @ts-check
/**
 * Identity colormaps, generated at runtime in OKLab so both strands share one
 * perceptual lightness ladder.
 *
 * Anchors come from the validated reference palette (dataviz skill,
 * `palette.md`): forward = categorical slot 1 (blue), reverse = slot 2
 * (orange) — the classic CVD-safe pair. In light mode the blue ramp is the
 * documented sequential ramp, steps 250–700 (light end capped at 2:1 surface
 * contrast per the ordinal rule); the orange ramp mirrors its exact OKLab
 * lightness ladder at the orange hue. In dark mode the anchor flips: high
 * identity is the *bright* end.
 */

// ---------------------------------------------------------------------------
// OKLab / OKLCH (Björn Ottosson's reference transform)

/** @param {number} c */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** @param {number} c */
function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * @param {number} r @param {number} g @param {number} b 0..1 sRGB
 * @returns {[number, number, number]} [L, a, b]
 */
export function srgbToOklab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * @param {number} L @param {number} a @param {number} b
 * @returns {[number, number, number] | null} sRGB 0..1, or null when out of gamut
 */
function oklabToSrgbRaw(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  if (r < -1e-4 || r > 1 + 1e-4 || g < -1e-4 || g > 1 + 1e-4 || bb < -1e-4 || bb > 1 + 1e-4) {
    return null;
  }
  return [
    Math.min(1, Math.max(0, linearToSrgb(r))),
    Math.min(1, Math.max(0, linearToSrgb(g))),
    Math.min(1, Math.max(0, linearToSrgb(bb))),
  ];
}

/**
 * OKLCH -> sRGB with chroma reduced until in gamut.
 * @param {number} L @param {number} C @param {number} hRad
 * @returns {[number, number, number]}
 */
export function oklchToSrgb(L, C, hRad) {
  let c = C;
  for (let i = 0; i < 48; i++) {
    const rgb = oklabToSrgbRaw(L, c * Math.cos(hRad), c * Math.sin(hRad));
    if (rgb) return rgb;
    c *= 0.94;
  }
  const rgb = oklabToSrgbRaw(L, 0, 0);
  return rgb ?? [0, 0, 0];
}

/** @param {string} hex @returns {[number, number, number]} 0..1 */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** @param {[number, number, number]} rgb 0..1 */
export function rgbToHex(rgb) {
  const b = rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  return '#' + b.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Ramps

// Documented sequential blue, steps 250..700 (light mode).
const BLUE_LIGHT_ANCHORS = [
  '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6',
  '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b',
];

// Categorical slot anchors (hue + flat colors) per mode.
const SLOTS = {
  light: { fwd: '#2a78d6', rev: '#eb6834' },
  dark: { fwd: '#3987e5', rev: '#d95926' },
};

/** @param {string} hex @returns {{L: number, C: number, h: number}} */
function hexToOklch(hex) {
  const [L, a, b] = srgbToOklab(...hexToRgb(hex));
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

/**
 * Anchor list (10 OKLab stops, low->high identity) for one strand and mode.
 * @param {'light'|'dark'} mode
 * @param {0|1} strand
 * @returns {{L: number, C: number, h: number}[]}
 */
function rampAnchors(mode, strand) {
  const hue = hexToOklch(SLOTS[mode][strand === 0 ? 'fwd' : 'rev']).h;
  if (mode === 'light') {
    // Lightness + chroma ladder of the documented blue ramp, re-hued.
    return BLUE_LIGHT_ANCHORS.map((hex) => {
      const { L, C } = hexToOklch(hex);
      return { L, C, h: hue };
    });
  }
  // Dark mode: anchor flips — high identity is the bright, saturated end.
  const out = [];
  for (let i = 0; i < 10; i++) {
    const t = i / 9;
    out.push({ L: 0.47 + t * 0.33, C: 0.085 + t * 0.05, h: hue });
  }
  return out;
}

/**
 * Sample a ramp at t in [0,1] (linear interpolation between anchors, in OKLCH).
 * @param {{L: number, C: number, h: number}[]} anchors
 * @param {number} t
 * @returns {[number, number, number]}
 */
function sampleRamp(anchors, t) {
  const x = Math.min(1, Math.max(0, t)) * (anchors.length - 1);
  const i = Math.min(anchors.length - 2, Math.floor(x));
  const f = x - i;
  const a = anchors[i];
  const b = anchors[i + 1];
  return oklchToSrgb(a.L + f * (b.L - a.L), a.C + f * (b.C - a.C), a.h + f * (b.h - a.h));
}

// Multiplicity ramp endpoints (neutral -> ink, matching the axis lane):
// unique sequence stays quiet, deep repeat families carry the ink.
const MULT_ENDS = {
  light: { lo: '#d2d6de', hi: '#282e3a' },
  dark: { lo: '#464c5a', hi: '#d4dceb' },
};

// The ANI heatmap's ramp: multi-hue sequential (viridis anchors, CVD-safe,
// the visual language of published identity heatmaps). Satellite arrays sit
// in a narrow high-identity band; a single-hue ramp compresses 97 vs 99.5
// vs 100% into near-identical shades, while hue changes keep them apart.
// Interpolated in OKLab; theme-independent by design (self-contained scale).
const ANI_ANCHORS = ['#440154', '#46327e', '#365c8d', '#277f8e', '#1fa187', '#4ac16d', '#a0da39', '#fde725'];

/** @param {number} t 0..1 @returns {[number, number, number]} */
function sampleAniRamp(t) {
  const x = Math.min(1, Math.max(0, t)) * (ANI_ANCHORS.length - 1);
  const i = Math.min(ANI_ANCHORS.length - 2, Math.floor(x));
  const f = x - i;
  const a = srgbToOklab(...hexToRgb(ANI_ANCHORS[i]));
  const b = srgbToOklab(...hexToRgb(ANI_ANCHORS[i + 1]));
  const rgb = oklabToSrgbRaw(
    a[0] + f * (b[0] - a[0]),
    a[1] + f * (b[1] - a[1]),
    a[2] + f * (b[2] - a[2]),
  );
  return rgb ?? hexToRgb(ANI_ANCHORS[i + 1]);
}

/**
 * OKLab-interpolated neutral ramp sample for the multiplicity scale.
 * @param {'light'|'dark'} mode @param {number} t 0..1
 * @returns {[number, number, number]}
 */
function sampleMultRamp(mode, t) {
  const a = srgbToOklab(...hexToRgb(MULT_ENDS[mode].lo));
  const b = srgbToOklab(...hexToRgb(MULT_ENDS[mode].hi));
  const f = Math.min(1, Math.max(0, t));
  const rgb = oklabToSrgbRaw(
    a[0] + f * (b[0] - a[0]),
    a[1] + f * (b[1] - a[1]),
    a[2] + f * (b[2] - a[2]),
  );
  return rgb ?? hexToRgb(MULT_ENDS[mode].hi);
}

/** Log scale shared by every multiplicity display: 1× → 0, ≥~316× → 1.
 * @param {number} mult */
export function multT(mult) {
  return Math.min(1, Math.log10(Math.max(mult, 1)) / 2.5);
}

/**
 * Build the 256x6 RGBA colormap texture:
 * row 0 = forward identity ramp, row 1 = reverse identity ramp,
 * row 2 = forward flat, row 3 = reverse flat,
 * rows 4+5 = multiplicity ramp (identical, so the shader's
 * strand + mode*2 row arithmetic lands on it for either strand).
 */
/** @type {Partial<Record<'light'|'dark', ReturnType<typeof makeColormap>>>} */
const colormapCache = {};

/**
 * Memoized per theme: the full OKLab resampling ran from scratch at seven
 * call sites (theme swaps, legends, lanes, exports) — and a shared object
 * makes it structurally impossible for consumers to hold divergent ramps.
 * @param {'light'|'dark'} mode
 */
export function buildColormap(mode) {
  return colormapCache[mode] ?? (colormapCache[mode] = makeColormap(mode));
}

/** @param {'light'|'dark'} mode */
function makeColormap(mode) {
  const data = new Uint8Array(256 * 6 * 4);
  const fwdAnchors = rampAnchors(mode, 0);
  const revAnchors = rampAnchors(mode, 1);
  const fwdFlat = hexToRgb(SLOTS[mode].fwd);
  const revFlat = hexToRgb(SLOTS[mode].rev);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    writeRgba(data, 0 * 256 + i, sampleRamp(fwdAnchors, t));
    writeRgba(data, 1 * 256 + i, sampleRamp(revAnchors, t));
    writeRgba(data, 2 * 256 + i, fwdFlat);
    writeRgba(data, 3 * 256 + i, revFlat);
    const m = sampleMultRamp(mode, t);
    writeRgba(data, 4 * 256 + i, m);
    writeRgba(data, 5 * 256 + i, m);
  }
  return {
    data,
    width: 256,
    height: 6,
    fwdFlat: SLOTS[mode].fwd,
    revFlat: SLOTS[mode].rev,
    /**
     * CSS gradient for the legend swatch.
     * @param {0|1} strand
     */
    rampCss(strand) {
      const anchors = strand === 0 ? fwdAnchors : revAnchors;
      const stops = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        stops.push(`${rgbToHex(sampleRamp(anchors, t))} ${Math.round(t * 100)}%`);
      }
      return `linear-gradient(90deg, ${stops.join(', ')})`;
    },
    /** 256×1 RGBA pixels of the ANI ramp — CPU heatmap painting only
     * (kept out of the GL colormap texture so shader row math stays put). */
    aniData: (() => {
      const a = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) writeRgba(a, i, sampleAniRamp(i / 255));
      return a;
    })(),
    /** CSS gradient for the ANI legend swatch. */
    aniRampCss() {
      const stops = [];
      for (let i = 0; i <= 7; i++) {
        const t = i / 7;
        stops.push(`${rgbToHex(sampleAniRamp(t))} ${Math.round(t * 100)}%`);
      }
      return `linear-gradient(90deg, ${stops.join(', ')})`;
    },
    /** CSS gradient for the multiplicity legend swatch. */
    multRampCss() {
      const stops = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        stops.push(`${rgbToHex(sampleMultRamp(mode, t))} ${Math.round(t * 100)}%`);
      }
      return `linear-gradient(90deg, ${stops.join(', ')})`;
    },
    /** "r,g,b" string at a multiplicity fraction, for canvas/lane consumers. */
    multRgb(/** @type {number} */ t) {
      const rgb = sampleMultRamp(mode, t);
      return rgb.map((c) => Math.round(c * 255)).join(',');
    },
  };
}

/**
 * Downsample the per-tile multiplicity profile into a width-wide R8 texture
 * of log-scaled fractions (see multT) for the shader's color-by-multiplicity
 * mode — the mean of log-multiplicity per texel, matching the axis lane's
 * bucketing.
 * @param {{tileBp: number, mult: Float32Array}} profile
 * @param {number} [width]
 * @returns {Uint8Array}
 */
export function buildMultiplicityTex(profile, width = 8192) {
  const n = profile.mult.length;
  const w = Math.max(1, Math.min(width, n));
  const out = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    const t0 = Math.floor((x * n) / w);
    const t1 = Math.max(t0 + 1, Math.floor(((x + 1) * n) / w));
    let sum = 0;
    let cnt = 0;
    for (let t = t0; t < t1 && t < n; t++) {
      if (profile.mult[t] <= 0) continue;
      sum += Math.log10(profile.mult[t]);
      cnt++;
    }
    // One scale for texture, lane, and legend: multT owns the constant.
    out[x] = cnt === 0 ? 0 : Math.round(multT(Math.pow(10, sum / cnt)) * 255);
  }
  return out;
}

/**
 * @param {Uint8Array} data @param {number} texel
 * @param {[number, number, number]} rgb
 */
function writeRgba(data, texel, rgb) {
  const o = texel * 4;
  data[o] = Math.round(rgb[0] * 255);
  data[o + 1] = Math.round(rgb[1] * 255);
  data[o + 2] = Math.round(rgb[2] * 255);
  data[o + 3] = 255;
}
