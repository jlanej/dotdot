// @ts-check
/**
 * Built-in reference genomes, IGV-style: each entry names a remote 2bit
 * (UCSC serves them with CORS + byte ranges) plus showcase regions worth a
 * self-plot. Adding a reference is one entry here.
 */
import { parseBp } from './core/region.js';

/**
 * @typedef {Object} RefPreset
 * @property {string} label
 * @property {string} region region expression: browser syntax (1-based inclusive) or a
 *   cytogenetic arm (`chr13p`), a comma/semicolon list of those, or two such sides joined
 *   by " vs " — see splitCrossSpec / splitRegionList / parseBrowserRegion below
 */

/**
 * @typedef {Object} RefTrack
 * @property {string} id
 * @property {string} label
 * @property {string} url remote bigBed (CORS + byte ranges)
 * @property {boolean} on drawn by default
 * @property {boolean} [colored] items carry meaningful itemRgb (CenSat)
 */

/**
 * @typedef {Object} ReferenceGenome
 * @property {string} id
 * @property {string} label
 * @property {string} twobit
 * @property {string} defaultRegion
 * @property {RefPreset[]} presets
 * @property {RefTrack[]} tracks annotation bigBeds for this genome
 * @property {string} [cytoband] cytoband bigBed — enables chr13p/q arm syntax
 */

/** @type {ReferenceGenome[]} */
export const REFERENCES = [
  {
    id: 't2t',
    label: 'T2T-CHM13v2.0',
    twobit: 'https://hgdownload.soe.ucsc.edu/goldenPath/hs1/bigZips/hs1.2bit',
    defaultRegion: 'chrX:57,820,000-60,670,000',
    presets: [
      { label: 'chrX centromere — DXZ1 α-satellite HOR array', region: 'chrX:57,820,000-60,670,000' },
      { label: 'chr8 centromere — the first finished centromere', region: 'chr8:44,200,000-46,330,000' },
      { label: 'chr17 centromere — D17Z1 α-satellite', region: 'chr17:23,900,000-27,000,000' },
      { label: 'chr1 pericentromere — αSat/HSat mosaic', region: 'chr1:121,700,000-125,100,000' },
      { label: 'acrocentric p arms — all five short arms vs themselves', region: 'chr13p,chr14p,chr15p,chr21p,chr22p' },
      { label: 'chr21p vs chr22p — two acrocentric arms, directly', region: 'chr21p vs chr22p' },
    ],
    cytoband: 'https://hgdownload.soe.ucsc.edu/gbdb/hs1/cytoBandMapped/cytoBandMapped.bb',
    tracks: [
      {
        id: 'censat',
        label: 'CenSat — satellite families',
        url: 'https://hgdownload.soe.ucsc.edu/gbdb/hs1/censat/censat.bb',
        on: true,
        colored: true,
      },
      {
        id: 'genes',
        label: 'genes — CAT/Liftoff',
        url: 'https://hgdownload.soe.ucsc.edu/gbdb/hs1/catLiftOffGenesV1/catLiftOffGenesV1.bb',
        on: true,
      },
      {
        id: 'segdup',
        label: 'segmental duplications — SEDEF',
        url: 'https://hgdownload.soe.ucsc.edu/gbdb/hs1/sedefSegDups/sedefSegDups.bb',
        on: false,
      },
    ],
  },
  {
    id: 'hg38',
    label: 'GRCh38 (hg38)',
    twobit: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/latest/hg38.2bit',
    defaultRegion: 'chr1:145,000,000-146,000,000',
    presets: [],
    tracks: [],
  },
];

/**
 * Split a cross-comparison spec: `chr21p vs chr22p` puts the left side on
 * the target (x) axis and the right side on the query (y) axis — each side
 * may itself be a region list. Without a ` vs ` the whole text is the
 * target (self-plot semantics as before).
 * @param {string} text
 * @returns {{target: string, query: string | null}}
 */
export function splitCrossSpec(text) {
  const m = /^(.*?)\s+vs\.?\s+(.*)$/i.exec(text.trim());
  if (m && m[1].trim() && m[2].trim()) return { target: m[1].trim(), query: m[2].trim() };
  return { target: text.trim(), query: null };
}

/**
 * Split a region-list expression. `;` always delimits; `,` delimits only
 * when followed by a letter/underscore, so thousands separators inside
 * coordinates survive (`chr1:121,700,000-125M,chr8p` is two regions).
 * @param {string} text
 * @returns {string[]}
 */
export function splitRegionList(text) {
  return text
    .split(/;|,(?=\s*[A-Za-z_])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse genome-browser region syntax: `chrX:57,820,000-60,670,000` (1-based
 * inclusive; k/M/G suffixes fine), a bare sequence name for the whole
 * sequence, or a cytogenetic arm (`chr13p`, `chrXq`).
 * @param {string} text
 * @returns {{chrom: string, start1: number | null, end1: number | null, arm: 'p' | 'q' | null} | null}
 */
export function parseBrowserRegion(text) {
  const s = text.trim();
  if (!s) return null;
  const colon = s.lastIndexOf(':');
  let chrom = colon < 0 ? s : s.slice(0, colon).trim();
  /** @type {'p' | 'q' | null} */
  let arm = null;
  const am = /^(chr[0-9XYM]+)([pq])$/i.exec(chrom);
  if (am) {
    chrom = am[1];
    arm = /** @type {'p' | 'q'} */ (am[2].toLowerCase());
  }
  if (colon < 0) return { chrom, start1: null, end1: null, arm };
  const range = s.slice(colon + 1);
  const dash = range.split(/[-–]/);
  if (dash.length !== 2 || !chrom) return null;
  // One bp grammar for the whole app: parseBp also backs the region-jump box
  // and every free-text length field.
  const a = Math.round(parseBp(dash[0]));
  const b = Math.round(parseBp(dash[1]));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) return null;
  return { chrom, start1: a, end1: b, arm };
}
