// @ts-check
/**
 * Pool-result assembly: merge per-chunk matcher outputs into one
 * SegmentStore, stitching the runs the chunk cuts split and re-applying
 * minRunLen to edge pieces afterwards — the assembled plot is
 * segment-for-segment faithful to a single-core run of the same options.
 *
 * The stitch rule is the matcher's own bridge rule expressed in output
 * space: two pieces continue one run iff they share a diagonal, the anchor
 * gap at the join is within maxGap + sampleHole, and no record boundary
 * lies between them (runs never cross records). Contiguous anchors leave a
 * k-1 bp overlap between split pieces, so the output-space join gap for a
 * bridgeable anchor gap g is g - (k - 1) — hence the tolerance below.
 */
import { MAX_SEGMENTS } from '../core/kmer.js';
import { allocSegments, copySegmentRow } from '../core/types.js';

/** @typedef {import('../core/types.js').SegmentStore} SegmentStore */
/**
 * @typedef {SegmentStore & {edge?: Uint8Array}} PartResult
 */

/**
 * @param {{shared: {opts: {k:number, maxGap:number, minRunLen:number, qSample?:number, stride?:number}}, target: {starts: Float64Array}, query: {starts: Float64Array}}} plan
 * @param {PartResult[]} parts
 * @returns {{segments: SegmentStore, identMin: number}}
 */
export function assemblePool(plan, parts) {
  const opts = plan.shared.opts;
  const k = opts.k;
  const sampleHole = (opts.qSample ?? 1) * Math.max(1, opts.stride ?? 1) - 1;
  const tolOut = opts.maxGap + sampleHole + 1 - k;
  const minRunLen = opts.minRunLen;
  const tStarts = plan.target.starts;
  const qStarts = plan.query.starts;

  // Collect cut-touching pieces into per-diagonal chains.
  /** @type {Map<number, {p:number, i:number}[]>} */
  const fwdChains = new Map();
  /** @type {Map<number, {p:number, i:number}[]>} */
  const revChains = new Map();
  for (let p = 0; p < parts.length; p++) {
    const r = parts[p];
    const e = r.edge;
    if (!e) continue;
    for (let i = 0; i < r.count; i++) {
      if (e[i] !== 1) continue;
      // Diagonal invariant per run: fwd y - x; rev x + dx + y.
      const key = r.strand[i] === 0 ? r.y[i] - r.x[i] : r.x[i] + r.dx[i] + r.y[i];
      const map = r.strand[i] === 0 ? fwdChains : revChains;
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      list.push({ p, i });
    }
  }

  /** Band index of position v (record containment; runs are intra-record). */
  /** @param {Float64Array} starts @param {number} v */
  const bandOf = (starts, v) => {
    let lo = 0;
    let hi = starts.length - 2;
    while (lo < hi) {
      const mid = lo + ((hi - lo) >>> 1);
      if (starts[mid + 1] > v) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  /** @type {{x:number, y:number, len:number, strand:number, identity:number}[]} */
  const mergedRows = [];
  /** @type {Set<number>} */
  const consumed = new Set();
  /** @param {number} p @param {number} i */
  const gid = (p, i) => p * 0x100000000 + i;

  /** @param {Map<number, {p:number, i:number}[]>} chains @param {0|1} strand */
  const stitchChains = (chains, strand) => {
    for (const list of chains.values()) {
      if (list.length < 2) continue;
      // Walk the diagonal in scan order: fwd by ascending y, rev downward
      // (the rc scan advances toward smaller output y).
      list.sort((a, b) =>
        strand === 0
          ? parts[a.p].y[a.i] - parts[b.p].y[b.i]
          : parts[b.p].y[b.i] + parts[b.p].dy[b.i] - (parts[a.p].y[a.i] + parts[a.p].dy[a.i]),
      );
      /** @type {{x:number, y:number, len:number, matched:number, tBand:number, qBand:number, pieces:{p:number,i:number}[]} | null} */
      let acc = null;
      const flush = () => {
        if (acc && acc.pieces.length > 1) {
          for (const c of acc.pieces) consumed.add(gid(c.p, c.i));
          mergedRows.push({
            x: acc.x,
            y: acc.y,
            len: acc.len,
            strand,
            identity: Math.min(1, Math.max(0, acc.matched / acc.len)),
          });
        }
        acc = null;
      };
      for (const c of list) {
        const r = parts[c.p];
        const x = r.x[c.i];
        const y = r.y[c.i];
        const len = r.dx[c.i];
        const matched = r.identity[c.i] * len;
        const tB = bandOf(tStarts, x);
        const qB = bandOf(qStarts, y);
        if (acc !== null) {
          const gapOut = strand === 0 ? y - (acc.y + acc.len) : acc.y - (y + len);
          if (gapOut <= tolOut && tB === acc.tBand && qB === acc.qBand) {
            const gapAnchors = gapOut + k - 1;
            const realGap = Math.max(0, gapAnchors - sampleHole);
            // matched_merged = mA + mB + gapOut - realGap (k-1 overlap
            // deduplicated; bridged sampling holes count as matched, real
            // gaps do not — the matcher's own bookkeeping).
            acc.matched += matched + gapOut - realGap;
            acc.len += len + gapOut;
            if (strand === 1) acc.y = y;
            acc.pieces.push(c);
            continue;
          }
          flush();
        }
        // (For rev chains the walk starts at the top piece, which already
        // carries the run's minimum x — acc.x never needs updating.)
        acc = { x, y, len, matched, tBand: tB, qBand: qB, pieces: [c] };
      }
      flush();
    }
  };
  stitchChains(fwdChains, 0);
  stitchChains(revChains, 1);

  // Survivors: everything except consumed pieces and unstitched edge pieces
  // (or merged runs) still below minRunLen.
  /** @param {PartResult} r @param {number} p @param {number} i */
  const keep = (r, p, i) => {
    if (consumed.has(gid(p, i))) return false;
    if (r.edge && r.edge[i] === 1 && r.dx[i] < minRunLen) return false;
    return true;
  };
  let total = 0;
  for (let p = 0; p < parts.length; p++) {
    const r = parts[p];
    for (let i = 0; i < r.count; i++) if (keep(r, p, i)) total++;
  }
  const mergedKept = mergedRows.filter((m) => m.len >= minRunLen);
  total += mergedKept.length;
  if (total > MAX_SEGMENTS) {
    throw new Error('Too many match segments — raise k, lower max occurrences, or add a stride.');
  }

  const segments = allocSegments(total);
  let identMin = 1;
  let w = 0;
  for (let p = 0; p < parts.length; p++) {
    const r = parts[p];
    for (let i = 0; i < r.count; i++) {
      if (!keep(r, p, i)) continue;
      copySegmentRow(segments, w, r, i);
      if (r.identity[i] < identMin) identMin = r.identity[i];
      w++;
    }
  }
  for (const m of mergedKept) {
    segments.x[w] = m.x;
    segments.y[w] = m.y;
    segments.dx[w] = m.len;
    segments.dy[w] = m.len;
    segments.strand[w] = m.strand;
    segments.identity[w] = m.identity;
    if (m.identity < identMin) identMin = m.identity;
    w++;
  }
  return { segments, identMin };
}
