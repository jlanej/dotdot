// @ts-check
/**
 * PAF (Pairwise mApping Format) parsing — the aligner-audit input.
 *
 * Numbers are parsed straight from the bytes (no per-line string split);
 * only sequence names are decoded. Two consumers share one scanner:
 *  - parsePaf(): standalone plot — sequences laid out per axis in descending
 *    length order, every alignment one segment colored by nmatch/alnlen.
 *  - parsePafOnto(): overlay — alignments mapped onto axes that already
 *    exist (a loaded FASTA comparison), so an aligner's calls can be drawn
 *    over the alignment-free k-mer truth.
 */
import { F64Vec, F32Vec, U8Vec, U32Vec } from '../core/vec.js';

/** @typedef {import('../core/types.js').PlotData} PlotData */
/** @typedef {import('../core/types.js').AxisCatalog} AxisCatalog */
/** @typedef {import('../core/types.js').SegmentStore} SegmentStore */

const NL = 10;
const CR = 13;
const TAB = 9;
const HASH = 35;
const PLUS = 43;
const MINUS = 45;

const td = new TextDecoder();

/**
 * @callback PafRecordFn
 * @param {string} qName @param {number} qlen @param {number} qs @param {number} qe
 * @param {0|1} strand
 * @param {string} tName @param {number} tlen @param {number} ts @param {number} te
 * @param {number} ident
 */

/**
 * Scan PAF bytes, invoking onRecord per well-formed alignment line.
 * @param {Uint8Array} bytes
 * @param {PafRecordFn} onRecord
 * @returns {number} count of malformed (skipped) lines
 */
function scanRecords(bytes, onRecord) {
  const n = bytes.length;
  const fs = new Int32Array(12);
  const fe = new Int32Array(12);
  let skipped = 0;
  let i = 0;
  while (i < n) {
    let eol = i;
    while (eol < n && bytes[eol] !== NL) eol++;
    let end = eol;
    if (end > i && bytes[end - 1] === CR) end--;

    if (end > i && bytes[i] !== HASH) {
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
          fe[4] - fs[4] === 1 && (strandByte === PLUS || strandByte === MINUS) &&
          qe > qs && te > ts
        ) {
          const qName = td.decode(bytes.subarray(fs[0], fe[0]));
          const tName = td.decode(bytes.subarray(fs[5], fe[5]));
          const ident = alnlen > 0 ? Math.min(nmatch / alnlen, 1) : 0;
          onRecord(qName, qlen, qs, qe, strandByte === PLUS ? 0 : 1, tName, tlen, ts, te, ident);
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }
    i = eol + 1;
  }
  return skipped;
}

/**
 * Standalone PAF plot.
 * @param {Uint8Array} bytes
 * @returns {PlotData}
 */
export function parsePaf(bytes) {
  const t0 = performance.now();

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
  const recTs = new F64Vec(4096);
  const recDx = new F32Vec(4096);
  const recDy = new F32Vec(4096);
  const recStrand = new U8Vec(4096);
  const recIdent = new F32Vec(4096);

  let identMin = 1;

  const skipped = scanRecords(bytes, (qName, qlen, qs, qe, strand, tName, tlen, ts, te, ident) => {
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
    if (ident < identMin) identMin = ident;
    recQ.push(qId);
    recT.push(tId);
    recQs.push(qs);
    recTs.push(ts);
    recDx.push(te - ts);
    recDy.push(qe - qs);
    recStrand.push(strand);
    recIdent.push(ident);
  });

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

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let r = 0; r < count; r++) {
    x[r] = tCat.offsets[recT.a[r]] + recTs.a[r];
    y[r] = qCat.offsets[recQ.a[r]] + recQs.a[r];
  }

  return {
    target: tCat.catalog,
    query: qCat.catalog,
    segments: {
      count,
      x,
      y,
      dx: recDx.done(),
      dy: recDy.done(),
      strand: recStrand.done(),
      identity: recIdent.done(),
    },
    source: 'paf',
    stats: {
      elapsedMs: performance.now() - t0,
      identMin,
      skippedLines: skipped,
    },
  };
}

/**
 * Overlay: map alignments onto existing axes by sequence name. Alignments
 * naming sequences absent from the axes are counted in `unknown` and
 * dropped; nothing else about the base plot changes.
 *
 * @param {Uint8Array} bytes
 * @param {AxisCatalog} target
 * @param {AxisCatalog} query
 * @returns {{segments: SegmentStore, skipped: number, unknown: number, identMin: number}}
 */
export function parsePafOnto(bytes, target, query) {
  /** @type {Map<string, number>} */
  const tOff = new Map();
  for (let i = 0; i < target.names.length; i++) tOff.set(target.names[i], target.starts[i]);
  /** @type {Map<string, number>} */
  const qOff = new Map();
  for (let i = 0; i < query.names.length; i++) qOff.set(query.names[i], query.starts[i]);

  const x = new F64Vec(4096);
  const y = new F64Vec(4096);
  const dx = new F32Vec(4096);
  const dy = new F32Vec(4096);
  const strand = new U8Vec(4096);
  const identity = new F32Vec(4096);
  let unknown = 0;
  let identMin = 1;

  const skipped = scanRecords(bytes, (qName, _qlen, qs, qe, str, tName, _tlen, ts, te, ident) => {
    const to = tOff.get(tName);
    const qo = qOff.get(qName);
    if (to === undefined || qo === undefined) {
      unknown++;
      return;
    }
    if (ident < identMin) identMin = ident;
    x.push(to + ts);
    y.push(qo + qs);
    dx.push(te - ts);
    dy.push(qe - qs);
    strand.push(str);
    identity.push(ident);
  });

  const count = x.n;
  if (count === 0) {
    throw new Error(
      unknown > 0
        ? `No alignments matched the loaded sequence names (${unknown} lines name other sequences).`
        : skipped > 0
          ? `No usable alignments (${skipped} malformed lines) — is this a PAF file?`
          : 'Empty PAF file.',
    );
  }

  return {
    segments: {
      count,
      x: x.done(),
      y: y.done(),
      dx: dx.done(),
      dy: dy.done(),
      strand: strand.done(),
      identity: identity.done(),
    },
    skipped,
    unknown,
    identMin,
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
 * Content sniff: 12+ tab-separated fields on the first data line.
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
