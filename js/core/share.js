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
 * @property {'seg'|'heat'|'ani'} draw
 * @property {number} col color mode (0 identity, 1 strand, 2 multiplicity)
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
  if (v.draw === 'heat' || v.draw === 'ani') parts.push(`draw=${v.draw}`);
  if (v.col === 1 || v.col === 2) parts.push(`col=${v.col}`);
  if (!v.fwd || !v.rev) parts.push(`str=${(v.fwd ? 'f' : '') + (v.rev ? 'r' : '')}`);
  if (v.auto) parts.push('auto=1');
  return '#' + parts.join('&');
}

/**
 * The compute options a link carries (the shapes matchOpts()/lastBaseKmer
 * produce in main.js).
 * @typedef {Object} MatchShareOpts
 * @property {number} k
 * @property {number} maxGap
 * @property {number} maxOcc Infinity = occurrence masking off
 * @property {number} minRunLen
 * @property {'auto'|'off'|number} sample
 * @property {number} [exactMaxBp] raised exact-mode ceiling ("off 512M")
 * @property {number} budgetX Infinity = anchor budget off
 * @property {number} [maxSegments] raised segment wall
 */

/**
 * Serialize NON-DEFAULT compute options onto a link's query params — the
 * write half of the matching-options grammar (initFromUrl's reads are the
 * other half; readMatchParams below is their pure core). Only options that
 * differ from the app defaults travel, so pristine links stay short.
 * @param {URLSearchParams} q mutated in place
 * @param {MatchShareOpts} mo
 * @param {number} [aniTiles] explicit ANI tile count (0/undefined = auto)
 */
export function writeMatchParams(q, mo, aniTiles = 0) {
  if (mo.k !== 15) q.set('k', String(mo.k));
  if (mo.maxGap !== 64) q.set('gap', String(mo.maxGap));
  if (mo.maxOcc !== 200) q.set('occ', mo.maxOcc === Infinity ? 'off' : String(mo.maxOcc));
  if (mo.minRunLen !== 0) q.set('minrun', String(mo.minRunLen));
  // Exact mode keeps its raised ceiling ("off 512M") so publication computes
  // reproduce — reconstructed from the options, not any editable field.
  if (mo.sample !== 'auto') {
    q.set(
      'sample',
      mo.sample === 'off'
        ? mo.exactMaxBp
          ? `off ${Math.round(mo.exactMaxBp / 1e6)}M`
          : 'off'
        : String(mo.sample),
    );
  }
  if (mo.budgetX !== 1) q.set('budget', mo.budgetX === Infinity ? 'off' : String(mo.budgetX));
  if (aniTiles > 0) q.set('anitiles', String(aniTiles));
  if (mo.maxSegments) q.set('wall', `${Math.round(mo.maxSegments / 1e6)}M`);
}

/**
 * Parse a link's matching params into field-ready text (the free-text
 * grammar each sidebar field speaks) plus the parsed wall override. Absent
 * params come back undefined — the caller leaves those fields alone.
 * @param {URLSearchParams} p
 * @param {(text: string) => number} parseBp the app's length parser
 * @returns {{k?: string, gap?: string, occ?: string, minrun?: string,
 *   sample?: string, budget?: string, anitiles?: string, wall: number}}
 */
export function readMatchParams(p, parseBp) {
  /** @param {string} name */
  const get = (name) => {
    const v = p.get(name);
    return v === null ? undefined : v;
  };
  /** @type {string | undefined} */
  let budget = get('budget');
  // Bare numbers re-suffix as multipliers ("4" → "4×") so the field reads
  // the way users type it; word values (off/auto) pass through.
  if (budget !== undefined && /^\d/.test(budget)) budget = `${budget}×`;
  let wall = 0;
  const w = p.get('wall');
  if (w !== null) {
    const v = parseBp(w);
    // The wall param only RAISES the 16M default (clamped to the 64M hard
    // ceiling) — a lowering or garbage value is ignored, not honored.
    if (Number.isFinite(v) && v > 16_000_000) wall = Math.min(64_000_000, Math.round(v));
  }
  return {
    k: get('k'),
    gap: get('gap'),
    occ: get('occ'),
    minrun: get('minrun'),
    sample: get('sample'),
    budget,
    anitiles: get('anitiles'),
    wall,
  };
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
    draw: q.get('draw') === 'heat' || q.get('draw') === 'ani' ? /** @type {'heat'|'ani'} */ (q.get('draw')) : 'seg',
    col: q.get('col') === '1' ? 1 : q.get('col') === '2' ? 2 : 0,
    fwd: str === null ? true : str.includes('f'),
    rev: str === null ? true : str.includes('r'),
    auto: q.get('auto') === '1',
  };
}
