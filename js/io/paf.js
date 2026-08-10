// @ts-check
/**
 * PAF (minimap2 Pairwise mApping Format) parser.
 *
 * Numbers are parsed straight from the bytes (no per-line string split);
 * only sequence names are decoded. Sequences are laid out on each axis in
 * descending length order (the D-Genies convention), and every alignment
 * becomes one segment colored by nmatch/alnlen identity.
 */
import { F64Vec, F32Vec, U8Vec, U32Vec } from '../core/vec.js';

/** @typedef {import('../core/types.js').PlotData} PlotData */

const NL = 10;
const CR = 13;
const TAB = 9;
const HASH = 35;
const PLUS = 43;

const td = new TextDecoder();

/**
 * @param {Uint8Array} bytes
 * @returns {PlotData}
 */
export function parsePaf(bytes) {
  const t0 = performance.now();
  const n = bytes.length;

  /** @type {Map<string, number>} */
  const qIds = new Map();
  /** @type {number[]} */
  const qLens = [];
  /** @type {Map<string, number>} */
  const tIds = new Map();
  /** @type {number[]} */
  const tLens = [];

  const recQ = new U32Vec(4096);
  const recT = new U32Vec(4096);
  const recQs = new F64Vec(4096);
  const recQe = new F64Vec(4096);
  const recTs = new F64Vec(4096);
  const recTe = new F64Vec(4096);
  const recStrand = new U8Vec(4096);
  const recIdent = new F32Vec(4096);

  let skipped = 0;
  let identMin = 1;

  // Reusable field boundaries for the first 12 columns.
  const fs = new Int32Array(12);
  const fe = new Int32Array(12);

  let i = 0;
  while (i < n) {
    // Find line end.
    let eol = i;
    while (eol < n && bytes[eol] !== NL) eol++;
    let end = eol;
    if (end > i && bytes[end - 1] === CR) end--;

    if (end > i && bytes[i] !== HASH) {
      // Split first 12 fields.
      let f = 0;
      let p = i;
      let start = i;
      while (p <= end && f < 12) {
        if (p === end || bytes[p] === TAB) {
          fs[f] = start;
          fe[f] = p;
          f++;
          start = p + 1;
        }
        p++;
      }
      if (f === 12) {
        const qlen = parseUint(bytes, fs[1], fe[1]);
        const qs = parseUint(bytes, fs[2], fe[2]);
        const qe = parseUint(bytes, fs[3], fe[3]);
        const tlen = parseUint(bytes, fs[6], fe[6]);
        const ts = parseUint(bytes, fs[7], fe[7]);
        const te = parseUint(bytes, fs[8], fe[8]);
        const nmatch = parseUint(bytes, fs[9], fe[9]);
        const alnlen = parseUint(bytes, fs[10], fe[10]);
        const strandByte = bytes[fs[4]];
        if (
          Number.isFinite(qlen) && Number.isFinite(qs) && Number.isFinite(qe) &&
          Number.isFinite(tlen) && Number.isFinite(ts) && Number.isFinite(te) &&
          Number.isFinite(nmatch) && Number.isFinite(alnlen) &&
          fe[4] - fs[4] === 1 && qe > qs && te > ts
        ) {
          const qName = td.decode(bytes.subarray(fs[0], fe[0]));
          const tName = td.decode(bytes.subarray(fs[5], fe[5]));
          let qId = qIds.get(qName);
          if (qId === undefined) {
            qId = qLens.length;
            qIds.set(qName, qId);
            qLens.push(qlen);
          }
          let tId = tIds.get(tName);
          if (tId === undefined) {
            tId = tLens.length;
            tIds.set(tName, tId);
            tLens.push(tlen);
          }
          const ident = alnlen > 0 ? Math.min(nmatch / alnlen, 1) : 0;
          if (ident < identMin) identMin = ident;
          recQ.push(qId);
          recT.push(tId);
          recQs.push(qs);
          recQe.push(qe);
          recTs.push(ts);
          recTe.push(te);
          recStrand.push(strandByte === PLUS ? 0 : 1);
          recIdent.push(ident);
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }
    i = eol + 1;
  }

  const count = recQ.n;
  if (count === 0) {
    throw new Error(
      skipped > 0
        ? `No usable alignments (${skipped} malformed lines) — is this a PAF file?`
        : 'Empty PAF file.',
    );
  }

  const qCat = buildCatalog(qIds, qLens);
  const tCat = buildCatalog(tIds, tLens);

  // Emit the segment store in global coordinates.
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const dx = new Float32Array(count);
  const dy = new Float32Array(count);
  const strand = recStrand.done();
  const identity = recIdent.done();
  for (let r = 0; r < count; r++) {
    const tOff = tCat.offsets[recT.a[r]];
    const qOff = qCat.offsets[recQ.a[r]];
    x[r] = tOff + recTs.a[r];
    y[r] = qOff + recQs.a[r];
    dx[r] = recTe.a[r] - recTs.a[r];
    dy[r] = recQe.a[r] - recQs.a[r];
  }

  return {
    target: tCat.catalog,
    query: qCat.catalog,
    segments: { count, x, y, dx, dy, strand, identity },
    source: 'paf',
    stats: {
      elapsedMs: performance.now() - t0,
      identMin,
      skippedLines: skipped,
    },
  };
}

/**
 * Order sequences by descending length (stable on first appearance) and
 * compute global offsets.
 * @param {Map<string, number>} ids
 * @param {number[]} lens
 */
function buildCatalog(ids, lens) {
  const m = lens.length;
  const order = Array.from({ length: m }, (_, i) => i);
  order.sort((a, b) => lens[b] - lens[a] || a - b);

  const namesById = new Array(m);
  for (const [name, id] of ids) namesById[id] = name;

  /** @type {string[]} */
  const names = [];
  const starts = new Float64Array(m + 1);
  const offsets = new Float64Array(m); // by original id
  let acc = 0;
  for (let rank = 0; rank < m; rank++) {
    const id = order[rank];
    names.push(namesById[id]);
    starts[rank] = acc;
    offsets[id] = acc;
    acc += lens[id];
  }
  starts[m] = acc;

  return { catalog: { names, starts, total: acc }, offsets };
}

/**
 * Parse a non-negative decimal integer from bytes[s..e); NaN on any
 * non-digit byte or empty range.
 * @param {Uint8Array} bytes @param {number} s @param {number} e
 */
function parseUint(bytes, s, e) {
  if (s >= e) return NaN;
  let v = 0;
  for (let i = s; i < e; i++) {
    const d = bytes[i] - 48;
    if (d < 0 || d > 9) return NaN;
    v = v * 10 + d;
  }
  return v;
}

/**
 * Content sniff: 12+ tab-separated fields with numeric field 2 on the first
 * data line.
 * @param {Uint8Array} bytes
 */
export function looksLikePaf(bytes) {
  const n = Math.min(bytes.length, 65536);
  let i = 0;
  while (i < n) {
    let eol = i;
    while (eol < n && bytes[eol] !== NL) eol++;
    if (eol > i && bytes[i] !== HASH) {
      let tabs = 0;
      for (let j = i; j < eol; j++) if (bytes[j] === TAB) tabs++;
      return tabs >= 11;
    }
    i = eol + 1;
  }
  return false;
}
