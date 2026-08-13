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
 * @property {string} region genome-browser syntax, 1-based inclusive
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
    ],
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
 * Parse genome-browser region syntax: `chrX:57,820,000-60,670,000` (1-based
 * inclusive; k/M/G suffixes fine) or a bare sequence name for the whole
 * sequence.
 * @param {string} text
 * @returns {{chrom: string, start1: number | null, end1: number | null} | null}
 */
export function parseBrowserRegion(text) {
  const s = text.trim();
  if (!s) return null;
  const colon = s.lastIndexOf(':');
  if (colon < 0) return { chrom: s, start1: null, end1: null };
  const chrom = s.slice(0, colon).trim();
  const range = s.slice(colon + 1);
  const dash = range.split(/[-–]/);
  if (dash.length !== 2 || !chrom) return null;
  // One bp grammar for the whole app: parseBp also backs the region-jump box
  // and every free-text length field.
  const a = Math.round(parseBp(dash[0]));
  const b = Math.round(parseBp(dash[1]));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) return null;
  return { chrom, start1: a, end1: b };
}
