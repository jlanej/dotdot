// @ts-check
/** Lookups over an AxisCatalog's global coordinate space. */

/** @typedef {import('./types.js').AxisCatalog} AxisCatalog */

/**
 * Which sequence contains global position g?
 * @param {AxisCatalog} cat
 * @param {number} g
 * @returns {{ index: number, name: string, local: number } | null}
 */
export function locate(cat, g) {
  const m = cat.names.length;
  if (m === 0 || g < 0 || g >= cat.total) return null;
  let lo = 0;
  let hi = m; // find last start <= g
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cat.starts[mid + 1] <= g) lo = mid + 1;
    else hi = mid;
  }
  return { index: lo, name: cat.names[lo], local: g - cat.starts[lo] };
}

/**
 * Indices of sequences whose bands intersect [w0, w1].
 * @param {AxisCatalog} cat
 * @param {number} w0 @param {number} w1
 * @returns {{ first: number, last: number }}
 */
export function bandsInRange(cat, w0, w1) {
  const m = cat.names.length;
  let lo = 0;
  let hi = m - 1;
  // first band with end > w0
  let first = m;
  let a = 0;
  let b = m - 1;
  while (a <= b) {
    const mid = (a + b) >>> 1;
    if (cat.starts[mid + 1] > w0) {
      first = mid;
      b = mid - 1;
    } else {
      a = mid + 1;
    }
  }
  // last band with start < w1
  let last = -1;
  a = lo;
  b = hi;
  while (a <= b) {
    const mid = (a + b) >>> 1;
    if (cat.starts[mid] < w1) {
      last = mid;
      a = mid + 1;
    } else {
      b = mid - 1;
    }
  }
  return { first, last };
}
