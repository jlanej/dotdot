// @ts-check
/**
 * Shareable view state: the exact viewport plus the display settings that
 * shape what it looks like, serialized into a URL hash fragment. The data
 * itself travels as query parameters (?ref=, ?demo=, ?target=…) — the hash
 * only says where to look and how.
 */

/**
 * @typedef {Object} ViewState
 * @property {number} x0 @property {number} x1 world x range
 * @property {number} y0 @property {number} y1 world y range
 * @property {string} len min-segment-length field text ('off' or a bp expression)
 * @property {number} ident min identity 0..1
 * @property {'seg'|'heat'} draw
 * @property {boolean} fwd @property {boolean} rev
 * @property {boolean} auto auto-refine enabled
 */

/**
 * @param {ViewState} v
 * @returns {string} hash fragment beginning with '#'
 */
export function buildViewHash(v) {
  const parts = [
    `v=${Math.round(v.x0)}-${Math.round(v.x1)}:${Math.round(v.y0)}-${Math.round(v.y1)}`,
  ];
  if (v.len && v.len !== 'off' && v.len !== '0') parts.push(`len=${encodeURIComponent(v.len)}`);
  if (v.ident > 0) parts.push(`ident=${v.ident.toFixed(3)}`);
  if (v.draw === 'heat') parts.push('draw=heat');
  if (!v.fwd || !v.rev) parts.push(`str=${(v.fwd ? 'f' : '') + (v.rev ? 'r' : '')}`);
  if (v.auto) parts.push('auto=1');
  return '#' + parts.join('&');
}

/**
 * Tolerant inverse of buildViewHash: unknown keys are ignored, a missing or
 * malformed viewport means no view state at all.
 * @param {string} hash location.hash (with or without the leading '#')
 * @returns {ViewState | null}
 */
export function parseViewHash(hash) {
  const s = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!s) return null;
  const q = new URLSearchParams(s);
  const v = q.get('v');
  if (!v) return null;
  const m = /^(-?\d+)-(-?\d+):(-?\d+)-(-?\d+)$/.exec(v);
  if (!m) return null;
  const x0 = Number(m[1]);
  const x1 = Number(m[2]);
  const y0 = Number(m[3]);
  const y1 = Number(m[4]);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const str = q.get('str');
  const ident = Number(q.get('ident') ?? 0);
  return {
    x0,
    x1,
    y0,
    y1,
    len: q.get('len') ?? 'off',
    ident: Number.isFinite(ident) ? Math.min(1, Math.max(0, ident)) : 0,
    draw: q.get('draw') === 'heat' ? 'heat' : 'seg',
    fwd: str === null ? true : str.includes('f'),
    rev: str === null ? true : str.includes('r'),
    auto: q.get('auto') === '1',
  };
}
