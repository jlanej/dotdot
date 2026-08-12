// @ts-check
/** Number formatting for genomic coordinates. */

/**
 * Human-readable bp quantity: "532 bp", "12.4 kb", "1.28 Mb", "3.1 Gb".
 * @param {number} v
 */
export function formatBp(v) {
  // Unit thresholds sit at 999.5 so values that would round up to "1000 kb"
  // promote to "1 Mb" instead.
  const a = Math.abs(v);
  if (a >= 999.5e6) return trim(v / 1e9) + ' Gb';
  if (a >= 999.5e3) return trim(v / 1e6) + ' Mb';
  if (a >= 999.5) return trim(v / 1e3) + ' kb';
  return `${Math.round(v)} bp`;
}

/** @param {number} x */
function trim(x) {
  const a = Math.abs(x);
  const dec = a < 10 ? 2 : a < 100 ? 1 : 0;
  return x.toFixed(dec).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
}

/**
 * Axis tick label with decimals derived from the tick step, so labels along
 * one axis are consistent: formatTick(24_500_000, 500_000) -> "24.5 Mb".
 * @param {number} v @param {number} step
 */
export function formatTick(v, step) {
  const ref = Math.max(Math.abs(v), step);
  let unit = 1;
  let suffix = ' bp';
  if (ref >= 1e9) {
    unit = 1e9;
    suffix = ' Gb';
  } else if (ref >= 1e6) {
    unit = 1e6;
    suffix = ' Mb';
  } else if (ref >= 1e3) {
    unit = 1e3;
    suffix = ' kb';
  }
  if (v === 0) return '0';
  const dec = Math.max(0, Math.ceil(-Math.log10(step / unit) - 1e-9));
  // Deep zoom on large coordinates: unit-scaled labels would collapse to the
  // same rounded value, so switch to exact positions.
  if (dec > 3) return formatInt(v);
  return (v / unit).toFixed(dec) + suffix;
}

/**
 * Integer with thousands separators.
 * @param {number} v
 */
export function formatInt(v) {
  return Math.round(v).toLocaleString('en-US');
}

/**
 * Compact segment count: "1.24 M", "532 k", "87".
 * @param {number} v
 */
export function formatCount(v) {
  if (v >= 1e6) return trim(v / 1e6) + ' M';
  if (v >= 1e3) return trim(v / 1e3) + ' k';
  return String(Math.round(v));
}
