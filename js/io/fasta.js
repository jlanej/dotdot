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
 * headerless single-sequence files, and `;` comment lines. Suspicious
 * shapes that parse but usually mean a broken file (a `>` inside a
 * sequence line — a record swallowed by a missing newline; a zero-length
 * record) come back as human-readable `warnings`.
 *
 * @param {Uint8Array} bytes
 * @param {string} [fallbackName] name used for a headerless file
 * @returns {{catalog: AxisCatalog, codes: Uint8Array, warnings: string[]}}
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
  let gtMidLine = 0;

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
        if (c !== CR && c !== SP && c !== TAB) {
          if (c === GT) gtMidLine++;
          codes[w++] = CODE[c];
        }
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

  /** @type {string[]} */
  const warnings = [];
  if (gtMidLine > 0) {
    warnings.push(
      `${gtMidLine} '>' character${gtMidLine > 1 ? 's' : ''} inside sequence lines — a header without a ` +
        'preceding newline (concatenated files?) was read as sequence, so a record may be missing',
    );
  }
  /** @type {string[]} */
  const empties = [];
  for (let s = 0; s < names.length; s++) {
    if (starts[s] === starts[s + 1]) empties.push(names[s]);
  }
  if (empties.length > 0) {
    warnings.push(`empty record${empties.length > 1 ? 's' : ''}: ${empties.slice(0, 3).join(', ')}${empties.length > 3 ? '…' : ''}`);
  }

  /** @type {import('../core/types.js').AxisCatalog} */
  const catalog = { names, starts, total: w };
  if (offsetList.some((o) => o > 0)) catalog.offsets = Float64Array.from(offsetList);

  return { catalog, codes: codes.subarray(0, w), warnings };
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
 * keeping its own name, ruler, and @offset display coordinates. Duplicate
 * record names across the merge (hap1.fa + hap2.fa both carrying "chr1")
 * are legal but make name-based lookups ambiguous — they surface as a
 * warning rather than a silent first/last-wins.
 * @param {{catalog: AxisCatalog, codes: Uint8Array, warnings?: string[]}[]} parts
 * @returns {{catalog: AxisCatalog, codes: Uint8Array, warnings?: string[]}}
 */
export function mergeParsedFasta(parts) {
  if (parts.length === 1) return parts[0]; // identity — warnings ride along
  /** @type {string[]} */
  const warnings = [];
  for (const p of parts) {
    if (p.warnings) warnings.push(...p.warnings);
  }
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
  const seen = new Set();
  const dups = new Set();
  for (const nm of names) {
    if (seen.has(nm)) dups.add(nm);
    seen.add(nm);
  }
  if (dups.size > 0) {
    const list = [...dups].slice(0, 3).join(', ');
    warnings.push(
      `duplicate sequence names across files (${list}${dups.size > 3 ? '…' : ''}) — ` +
        'name-based lookups (region jump, aligner overlays) are ambiguous for them',
    );
  }
  /** @type {AxisCatalog} */
  const catalog = { names, starts: Float64Array.from(startList), total: base };
  if (anyOffsets) catalog.offsets = Float64Array.from(offsetList);
  return { catalog, codes, warnings };
}
