// @ts-check
import { CODE } from '../core/dna.js';

/** @typedef {import('../core/types.js').AxisCatalog} AxisCatalog */

const GT = 62; // '>'
const NL = 10;
const CR = 13;
const SP = 32;
const TAB = 9;
const SEMI = 59; // ';' — ancient FASTA comment lines

const td = new TextDecoder();

/**
 * Parse FASTA bytes into 2-bit-alphabet codes plus a sequence catalog.
 * Single pass over the raw bytes; tolerates CRLF, lowercase, blank lines,
 * headerless single-sequence files, and `;` comment lines.
 *
 * @param {Uint8Array} bytes
 * @param {string} [fallbackName] name used for a headerless file
 * @returns {{catalog: AxisCatalog, codes: Uint8Array}}
 */
export function parseFasta(bytes, fallbackName = 'seq') {
  const n = bytes.length;
  /** @type {string[]} */
  const names = [];
  /** @type {number[]} */
  const startList = [];
  /** @type {number[]} */
  const offsetList = [];
  const codes = new Uint8Array(n); // upper bound; sequence <= file size
  let w = 0;
  let i = 0;
  let sawRecord = false;

  while (i < n) {
    const b = bytes[i];
    if (b === GT || b === SEMI) {
      // Header line, or a ';' comment line (legal anywhere in old-style FASTA)
      let j = i + 1;
      let nameEnd = -1;
      while (j < n && bytes[j] !== NL) {
        if (nameEnd < 0 && (bytes[j] === SP || bytes[j] === TAB || bytes[j] === CR)) nameEnd = j;
        j++;
      }
      if (b === GT) {
        const end = nameEnd >= 0 ? nameEnd : j;
        const name = td.decode(bytes.subarray(i + 1, end)).trim();
        names.push(name.length > 0 ? name : `seq${names.length + 1}`);
        startList.push(w);
        // Optional display-offset token in the description: `@offset=N`
        // marks a reference-region slice whose local 0 is genomic position N.
        let off = 0;
        if (nameEnd >= 0) {
          const desc = td.decode(bytes.subarray(nameEnd, j));
          // Anchored to whitespace so a description merely containing the
          // substring (e.g. "sample@offset=3") can't hijack coordinates.
          const m = /(?:^|\s)@offset=(\d+)(?=\s|$)/.exec(desc);
          if (m) off = Number(m[1]);
        }
        offsetList.push(off);
        sawRecord = true;
      }
      i = j + 1;
    } else if (b === NL || b === CR || b === SP || b === TAB) {
      i++;
    } else {
      if (!sawRecord) {
        names.push(fallbackName);
        startList.push(0);
        offsetList.push(0);
        sawRecord = true;
      }
      while (i < n) {
        const c = bytes[i];
        if (c === NL) break;
        if (c !== CR && c !== SP && c !== TAB) codes[w++] = CODE[c];
        i++;
      }
      i++;
    }
  }

  if (!sawRecord || w === 0) {
    throw new Error('No sequence data found — is this a FASTA file?');
  }

  const starts = new Float64Array(startList.length + 1);
  for (let s = 0; s < startList.length; s++) starts[s] = startList[s];
  starts[startList.length] = w;

  /** @type {import('../core/types.js').AxisCatalog} */
  const catalog = { names, starts, total: w };
  if (offsetList.some((o) => o > 0)) catalog.offsets = Float64Array.from(offsetList);

  return { catalog, codes: codes.subarray(0, w) };
}

/**
 * Quick content sniff: does this look like FASTA (vs PAF / other TSV)?
 * @param {Uint8Array} bytes
 */
export function looksLikeFasta(bytes) {
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) {
    const b = bytes[i];
    if (b === NL || b === CR || b === SP || b === TAB) continue;
    return b === GT || b === SEMI;
  }
  return false;
}

/**
 * Merge separately parsed FASTAs into one axis — the multi-file axis
 * feature: sequences from every file lie end to end in one catalog, each
 * keeping its own name, ruler, and @offset display coordinates.
 * @param {{catalog: AxisCatalog, codes: Uint8Array}[]} parts
 * @returns {{catalog: AxisCatalog, codes: Uint8Array}}
 */
export function mergeParsedFasta(parts) {
  if (parts.length === 1) return parts[0];
  let total = 0;
  let anyOffsets = false;
  for (const p of parts) {
    total += p.codes.length;
    if (p.catalog.offsets) anyOffsets = true;
  }
  const codes = new Uint8Array(total);
  /** @type {string[]} */
  const names = [];
  /** @type {number[]} */
  const startList = [];
  /** @type {number[]} */
  const offsetList = [];
  let base = 0;
  for (const p of parts) {
    codes.set(p.codes, base);
    const c = p.catalog;
    for (let i = 0; i < c.names.length; i++) {
      names.push(c.names[i]);
      startList.push(base + c.starts[i]);
      offsetList.push(c.offsets ? c.offsets[i] : 0);
    }
    base += p.codes.length;
  }
  startList.push(base);
  /** @type {AxisCatalog} */
  const catalog = { names, starts: Float64Array.from(startList), total: base };
  if (anyOffsets) catalog.offsets = Float64Array.from(offsetList);
  return { catalog, codes };
}
