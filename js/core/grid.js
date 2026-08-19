// @ts-check
/**
 * Static uniform grid over the plot domain for O(1) hover picking and
 * visible-segment queries. Segments are rasterized into every cell their
 * line crosses (Amanatides–Woo traversal), laid out with a counting sort.
 */
import { segmentEndpoints } from './types.js';

/** @typedef {import('./types.js').SegmentStore} SegmentStore */

const MAX_ENTRIES = 16_000_000;

export class SegmentGrid {
  /**
   * @param {SegmentStore} store
   * @param {number} W domain width (bp)
   * @param {number} H domain height (bp)
   */
  constructor(store, W, H) {
    this.store = store;
    this.W = Math.max(W, 1);
    this.H = Math.max(H, 1);

    let G = 1 << Math.round(Math.log2(Math.max(Math.sqrt(store.count || 1), 1)));
    G = Math.min(1024, Math.max(64, G));

    const ep = new Float64Array(4);
    // Shrink G until the entry count is acceptable.
    for (;;) {
      const cw = this.W / G;
      const ch = this.H / G;
      let entries = 0;
      for (let i = 0; i < store.count; i++) {
        segmentEndpoints(store, i, ep);
        entries +=
          Math.abs(this.cellOf(ep[2], cw, G) - this.cellOf(ep[0], cw, G)) +
          Math.abs(this.cellOf(ep[3], ch, G) - this.cellOf(ep[1], ch, G)) +
          1;
      }
      if (entries <= MAX_ENTRIES || G <= 64) {
        this.G = G;
        this.cw = cw;
        this.ch = ch;
        break;
      }
      G >>= 1;
    }

    const G2 = this.G * this.G;
    const cellStarts = new Uint32Array(G2 + 1);
    // Hoisted visitors: a fresh closure per segment (twice, at 8M+
    // segments) is pure nursery-GC churn inside a synchronous build.
    /** @param {number} cx @param {number} cy */
    const countVisit = (cx, cy) => {
      cellStarts[cy * this.G + cx + 1]++;
    };
    for (let i = 0; i < store.count; i++) {
      segmentEndpoints(store, i, ep);
      this.walk(ep[0], ep[1], ep[2], ep[3], countVisit);
    }
    for (let c = 0; c < G2; c++) cellStarts[c + 1] += cellStarts[c];
    const items = new Uint32Array(cellStarts[G2]);
    const cur = cellStarts.slice(0, G2);
    let fillIndex = 0;
    /** @param {number} cx @param {number} cy */
    const fillVisit = (cx, cy) => {
      items[cur[cy * this.G + cx]++] = fillIndex;
    };
    for (let i = 0; i < store.count; i++) {
      fillIndex = i;
      segmentEndpoints(store, i, ep);
      this.walk(ep[0], ep[1], ep[2], ep[3], fillVisit);
    }
    this.cellStarts = cellStarts;
    this.items = items;
    this.stamp = new Uint32Array(store.count);
    this.stampId = 0;
    this.ep = ep;
  }

  /**
   * @param {number} v @param {number} cellSize @param {number} G
   */
  cellOf(v, cellSize, G) {
    const c = Math.floor(v / cellSize);
    return c < 0 ? 0 : c >= G ? G - 1 : c;
  }

  /**
   * Visit every cell the segment (x0,y0)-(x1,y1) crosses.
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {(cx: number, cy: number) => void} visit
   */
  walk(x0, y0, x1, y1, visit) {
    const { cw, ch, G } = this;
    let cx = this.cellOf(x0, cw, G);
    let cy = this.cellOf(y0, ch, G);
    const ex = this.cellOf(x1, cw, G);
    const ey = this.cellOf(y1, ch, G);
    visit(cx, cy);
    if (cx === ex && cy === ey) return;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    let tMaxX = Infinity;
    let tMaxY = Infinity;
    let tDeltaX = Infinity;
    let tDeltaY = Infinity;
    if (dx !== 0) {
      const nextX = (cx + (stepX > 0 ? 1 : 0)) * cw;
      tMaxX = (nextX - x0) / dx;
      tDeltaX = Math.abs(cw / dx);
    }
    if (dy !== 0) {
      const nextY = (cy + (stepY > 0 ? 1 : 0)) * ch;
      tMaxY = (nextY - y0) / dy;
      tDeltaY = Math.abs(ch / dy);
    }

    let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 2;
    while (guard-- > 0) {
      if (tMaxX < tMaxY) {
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        cy += stepY;
        tMaxY += tDeltaY;
      }
      if (cx < 0 || cy < 0 || cx >= G || cy >= G) break;
      visit(cx, cy);
      if (cx === ex && cy === ey) break;
    }
  }

  /**
   * Visit each segment whose line crosses the world rect, deduplicated.
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @param {(segIndex: number) => void} visit
   */
  query(x0, y0, x1, y1, visit) {
    const { G, cw, ch, cellStarts, items, stamp } = this;
    const id = ++this.stampId;
    const cx0 = this.cellOf(Math.min(x0, x1), cw, G);
    const cx1 = this.cellOf(Math.max(x0, x1), cw, G);
    const cy0 = this.cellOf(Math.min(y0, y1), ch, G);
    const cy1 = this.cellOf(Math.max(y0, y1), ch, G);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * G + cx;
        for (let j = cellStarts[c]; j < cellStarts[c + 1]; j++) {
          const s = items[j];
          if (stamp[s] !== id) {
            stamp[s] = id;
            visit(s);
          }
        }
      }
    }
  }

  /**
   * Nearest segment to a screen point, in screen-space distance.
   * @param {import('./transform.js').View} view
   * @param {number} vpW @param {number} vpH
   * @param {number} mx mouse CSS px
   * @param {number} my
   * @param {number} maxDistPx
   * @returns {{ index: number, distPx: number } | null}
   */
  nearest(view, vpW, vpH, mx, my, maxDistPx) {
    const wx = view.pxToWorldX(mx, vpW);
    const wy = view.pxToWorldY(my, vpH);
    const rx = maxDistPx * view.bppX;
    const ry = maxDistPx * view.bppY;
    let best = -1;
    let bestD = maxDistPx;
    const ep = this.ep;
    this.query(wx - rx, wy - ry, wx + rx, wy + ry, (s) => {
      segmentEndpoints(this.store, s, ep);
      const x0 = view.worldToPxX(ep[0], vpW);
      const y0 = view.worldToPxY(ep[1], vpH);
      const x1 = view.worldToPxX(ep[2], vpW);
      const y1 = view.worldToPxY(ep[3], vpH);
      const d = pointSegDist(mx, my, x0, y0, x1, y1);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    });
    return best >= 0 ? { index: best, distPx: bestD } : null;
  }
}

/**
 * Distance from point (px,py) to segment (x0,y0)-(x1,y1).
 * @param {number} px @param {number} py
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 */
export function pointSegDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  const qx = x0 + t * dx;
  const qy = y0 + t * dy;
  return Math.hypot(px - qx, py - qy);
}
