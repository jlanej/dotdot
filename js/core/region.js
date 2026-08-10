// @ts-check
/**
 * Region expressions for the jump box: `<seq>[:<start>-<end>]` against an
 * axis catalog. Numbers accept thousands separators and k/M/G suffixes:
 *   chr17            → the whole sequence
 *   chr17:45M-46.5M  → 45,000,000..46,500,000 within chr17
 *   chr17:100,000-250,000
 *   45M-46M          → coordinates on the concatenated axis (single-seq axes)
 */

/** @typedef {import('./types.js').AxisCatalog} AxisCatalog */

/**
 * @param {string} text
 * @returns {number} bp value, or NaN
 */
export function parseBp(text) {
  const t = text.trim().toLowerCase().replaceAll(',', '').replaceAll(' ', '');
  const m = /^([0-9]*\.?[0-9]+)(bp|k|kb|m|mb|g|gb)?$/.exec(t);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  const unit = m[2] ?? 'bp';
  const mult = unit.startsWith('k') ? 1e3 : unit.startsWith('m') ? 1e6 : unit.startsWith('g') ? 1e9 : 1;
  return v * mult;
}

/**
 * Resolve a region expression to a global coordinate range on the axis.
 * @param {string} expr
 * @param {AxisCatalog} cat
 * @returns {{x0: number, x1: number, label: string} | null}
 */
export function resolveRegion(expr, cat) {
  const s = expr.trim();
  if (s.length === 0) return null;

  const colon = s.lastIndexOf(':');
  /** @type {string | null} */
  let name = null;
  let rangePart = s;
  if (colon > 0) {
    name = s.slice(0, colon).trim();
    rangePart = s.slice(colon + 1);
  } else if (!/[0-9]/.test(s[0]) || findSeq(cat, s) >= 0) {
    // Bare sequence name (names may start with digits, so check the catalog).
    name = s;
    rangePart = '';
  }

  let offset = 0;
  let limit = cat.total;
  if (name !== null) {
    const idx = findSeq(cat, name);
    if (idx < 0) return null;
    offset = cat.starts[idx];
    limit = cat.starts[idx + 1] - cat.starts[idx];
    if (rangePart.trim() === '') {
      return { x0: offset, x1: offset + limit, label: cat.names[idx] };
    }
  }

  const dash = splitRange(rangePart);
  if (!dash) return null;
  const a = parseBp(dash[0]);
  const b = parseBp(dash[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  const x0 = offset + Math.max(0, Math.min(a, limit));
  const x1 = offset + Math.max(0, Math.min(b, limit));
  if (x1 <= x0) return null;
  const label = name !== null ? `${name}:${dash[0]}-${dash[1]}` : `${dash[0]}-${dash[1]}`;
  return { x0, x1, label };
}

/**
 * Split "a-b" on the range dash, tolerating minus-free unit forms.
 * @param {string} s
 * @returns {[string, string] | null}
 */
function splitRange(s) {
  const parts = s.split(/[-–]/);
  if (parts.length !== 2) return null;
  return [parts[0], parts[1]];
}

/**
 * @param {AxisCatalog} cat @param {string} name
 */
function findSeq(cat, name) {
  const target = name.toLowerCase();
  for (let i = 0; i < cat.names.length; i++) {
    if (cat.names[i].toLowerCase() === target) return i;
  }
  return -1;
}
