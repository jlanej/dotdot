// @ts-check
/**
 * Matcher worker: one slice of the query, both strands, against the shared
 * k-mer index. Inputs arrive as SharedArrayBuffers (read-only by convention —
 * every worker only reads the shared arrays and writes its own output), so N
 * of these run on N cores with zero copies of the index or the query.
 *
 * The reverse pass mirrors this worker's own [qLo,qHi) into rc coordinates,
 * so the parts tile a refine window exactly as they tile the full query.
 * Runs touching a chunk cut are emitted below minRunLen with an edge flag;
 * the assembler stitches them back together and re-filters.
 */
import { matchStrand } from '../core/kmer.js';
import { newSegmentVecs, vecsToSegments, segmentBuffers } from '../core/types.js';

const post = /** @type {(msg: unknown, transfer?: Transferable[]) => void} */ (
  /** @type {any} */ (self).postMessage.bind(self)
);

self.onmessage = (ev) => {
  const req = /** @type {any} */ (ev).data;
  try {
    const s = req.shared;
    /** @type {import('../core/kmer.js').KmerIndex} */
    const index = {
      kmers: s.indexMeta.wide ? new Float64Array(s.kmersSab) : new Uint32Array(s.kmersSab),
      pos: new Uint32Array(s.posSab),
      bucketStarts: new Uint32Array(s.bucketsSab),
      ...s.indexMeta,
      occSumSq: new Float64Array(0),
    };
    const qCodes = new Uint8Array(s.qSab);
    const rcCodes = new Uint8Array(s.rcSab);
    const out = newSegmentVecs(1 << 14, true);
    /** @param {0|1} phase */
    const cb = (phase) => /** @param {number} d @param {number} t */ (d, t) =>
      post({ type: 'progress', part: req.part, phase, done: d, total: t });

    matchStrand(index, qCodes, s.qStarts, s.qTotal, s.tStarts, s.tTotal, s.opts, 0, out, cb(0), req.qLo, req.qHi);
    matchStrand(
      index, rcCodes, s.rcStarts, s.qTotal, s.tStarts, s.tTotal, s.opts, 1, out, cb(1),
      s.qTotal - req.qHi, s.qTotal - req.qLo,
    );

    const seg = /** @type {any} */ (vecsToSegments(out));
    seg.edge = /** @type {import('../core/vec.js').U8Vec} */ (out.edge).done();
    post({ type: 'done', part: req.part, seg }, [...segmentBuffers(seg), seg.edge.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
