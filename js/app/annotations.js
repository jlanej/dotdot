// @ts-check
/**
 * Annotation-lane building: resolve axis record names to chromosomes of the
 * annotation genome, fetch overlapping track items with 1 Mb tile caching,
 * and map them into world coordinates (respecting @offset slices and band
 * clipping). Pure of app state — the track source (bigBed readers) is
 * injected, so the offset math, the tile cache, and the name resolution are
 * unit-tested against an in-memory fake (misplaced annotations would be a
 * scientific error). The DOM/tick plumbing stays in main.js.
 */
import { bandsInRange } from '../core/catalog.js';
import { multT } from '../render/colormap.js';

/** @typedef {import('../io/bigbed.js').BedItem} BedItem */
/** @typedef {import('../render/axes.js').AnnoLane} AnnoLane */
/** @typedef {import('../render/axes.js').AnnoItem} AnnoItem */

/**
 * The slice of a bigBed reader the lane builder needs — RemoteBigBed
 * satisfies it structurally; tests inject an in-memory fake.
 * @typedef {{chroms(): Promise<Map<string, {id: number, size: number}>>,
 *   query(chrom: string, s: number, e: number): Promise<BedItem[]>}} TrackSource
 */

/**
 * Resolve an axis record name to a chromosome of the annotation genome:
 * exact match, arm suffix ('chr17p' → 'chr17'), or slice prefix
 * ('chr17_ROI10.9' → 'chr17').
 * @param {string} name @param {Map<string, {id:number, size:number}>} chroms
 */
export function resolveChrom(name, chroms) {
  if (chroms.has(name)) return name;
  const arm = /^(.+)[pq]$/.exec(name);
  if (arm && chroms.has(arm[1])) return arm[1];
  const prefix = name.split('_', 1)[0];
  return chroms.has(prefix) ? prefix : null;
}

export class LaneBuilder {
  /**
   * @param {(url: string) => TrackSource} getSource
   * @param {number} [tileBp] fetch granularity (1 Mb tiles)
   * @param {number} [maxTiles] cache bound (FIFO eviction)
   */
  constructor(getSource, tileBp = 1_000_000, maxTiles = 400) {
    this.getSource = getSource;
    this.tileBp = tileBp;
    this.maxTiles = maxTiles;
    /** @type {Map<string, BedItem[]>} `${url}|${chrom}|${tile}` -> items */
    this.tiles = new Map();
  }

  /**
   * Query one track with tile caching (items spanning tiles dedupe).
   * @param {import('../refs.js').RefTrack} track
   * @param {string} chrom @param {number} s @param {number} e
   */
  async tileQuery(track, chrom, s, e) {
    const src = this.getSource(track.url);
    const t0 = Math.max(0, Math.floor(s / this.tileBp));
    const t1 = Math.max(t0, Math.floor(Math.max(s, e - 1) / this.tileBp));
    /** @type {BedItem[]} */
    const out = [];
    const seen = new Set();
    for (let t = t0; t <= t1; t++) {
      const key = `${track.url}|${chrom}|${t}`;
      let arr = this.tiles.get(key);
      if (!arr) {
        arr = await src.query(chrom, t * this.tileBp, (t + 1) * this.tileBp);
        this.tiles.set(key, arr);
        if (this.tiles.size > this.maxTiles) {
          const oldest = this.tiles.keys().next().value;
          if (oldest !== undefined) this.tiles.delete(oldest);
        }
      }
      for (const it of arr) {
        if (it.end <= s || it.start >= e) continue;
        const k = `${it.start}:${it.end}:${it.name}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(it);
      }
    }
    return out;
  }

  /**
   * Build world-coordinate lanes for one axis, or null when no visible
   * record resolves to a chromosome of the annotation genome. Items map
   * through the band's @offset (slice-local ↔ genomic) and clip to the
   * band's world extent so a neighboring sequence never wears them.
   * @param {import('../core/types.js').AxisCatalog} cat
   * @param {number} w0 @param {number} w1
   * @param {import('../refs.js').RefTrack[]} tracks
   * @returns {Promise<AnnoLane[] | null>}
   */
  async buildAxisLanes(cat, w0, w1, tracks) {
    /** @type {AnnoLane[]} */
    const lanes = tracks.map((t) => ({ label: t.label, colored: !!t.colored, items: [] }));
    const { first, last } = bandsInRange(cat, w0, w1);
    if (last < first) return null;
    let resolvedAny = false;
    for (let i = first; i <= last; i++) {
      for (let k = 0; k < tracks.length; k++) {
        const chroms = await this.getSource(tracks[k].url).chroms();
        const chrom = resolveChrom(cat.names[i], chroms);
        if (!chrom) continue;
        resolvedAny = true;
        const off = cat.offsets ? cat.offsets[i] : 0;
        const bandStart = cat.starts[i];
        const bandEnd = cat.starts[i + 1];
        const visS = Math.max(w0, bandStart) - bandStart + off;
        const visE = Math.min(w1, bandEnd) - bandStart + off;
        if (visE <= visS) continue;
        const items = await this.tileQuery(tracks[k], chrom, Math.floor(visS), Math.ceil(visE));
        for (const it of items) {
          lanes[k].items.push({
            w0: Math.max(bandStart, bandStart + (it.start - off)),
            w1: Math.min(bandEnd, bandStart + (it.end - off)),
            rgb: it.rgb,
            name: it.name,
            strand: it.strand,
          });
        }
      }
    }
    return resolvedAny ? lanes : null;
  }
}

/**
 * Synthesize the k-mer multiplicity lane for one axis from the compute's
 * index profile — repeat structure at every level, in every draw mode.
 * Ink darkens with log copy number; unique-anchor territory stays blank.
 * World coordinates: the profile is indexed by global target position,
 * which IS both axes' world space (the query lane is only offered on
 * self-plots).
 * @param {{tileBp: number, mult: Float32Array, uniqFrac: Float32Array}} prof
 * @param {number} stride index stride (>1 = counts are estimates, '~')
 * @param {number} w0 @param {number} w1 visible world range
 * @param {number} pxSpan axis pixels, for bucket coarsening
 * @param {(t: number) => string} multRgb the theme's multiplicity ramp
 * @returns {AnnoLane | null}
 */
export function multLane(prof, stride, w0, w1, pxSpan, multRgb) {
  if (w1 <= w0) return null;
  // ≥2px buckets: tiles merge as you zoom out, stay hoverable zoomed in.
  const bucketBp = Math.max(prof.tileBp, ((w1 - w0) / Math.max(pxSpan, 1)) * 2);
  const approx = stride > 1 ? '~' : '';
  /** @type {AnnoItem[]} */
  const items = [];
  for (let s = Math.max(0, Math.floor(w0 / bucketBp) * bucketBp); s < w1; s += bucketBp) {
    const e = Math.min(w1, s + bucketBp);
    const t0 = Math.max(0, Math.floor(s / prof.tileBp));
    const t1 = Math.min(prof.mult.length, Math.ceil(e / prof.tileBp));
    let sumLog = 0;
    let uniq = 0;
    let n = 0;
    for (let t = t0; t < t1; t++) {
      if (prof.mult[t] <= 0) continue;
      sumLog += Math.log2(prof.mult[t]);
      uniq += prof.uniqFrac[t];
      n++;
    }
    if (n === 0) continue;
    const mult = Math.pow(2, sumLog / n);
    // Shared log scale (multT): full ink at ~300× — satellite fabric reads
    // solid, segdup territory mid-gray, unique sequence blank. The same
    // ramp colors segments in color-by-multiplicity mode.
    const tt = multT(mult);
    if (tt < 0.03) continue;
    items.push({
      w0: s,
      w1: e,
      rgb: multRgb(tt),
      name: `k-mers ${approx}${mult < 10 ? mult.toFixed(1) : String(Math.round(mult))}× · ${Math.round((uniq / n) * 100)}% unique`,
      strand: null,
    });
  }
  return { label: 'k-mer multiplicity', colored: true, items };
}
