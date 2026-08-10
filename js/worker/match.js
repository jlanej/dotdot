// @ts-check
/**
 * Matcher worker: one slice of the query, both strands, against the shared
 * k-mer index. Inputs arrive as SharedArrayBuffers (read-only by convention —
 * every worker only reads the shared arrays and writes its own output), so N
 * of these run on N cores with zero copies of the index or the query.
 */
import { matchStrand } from '../core/kmer.js';
import { F64Vec, F32Vec, U8Vec } from '../core/vec.js';

const post = /** @type {(msg: unknown, transfer?: Transferable[]) => void} */ (
  /** @type {any} */ (self).postMessage.bind(self)
);

self.onmessage = (ev) => {
  const req = /** @type {any} */ (ev).data;
  try {
    /** @type {import('../core/kmer.js').KmerIndex} */
    const index = {
      kmers: new Uint32Array(req.kmersSab),
      pos: new Uint32Array(req.posSab),
      bucketStarts: new Uint32Array(req.bucketsSab),
      shift: req.shift,
      mask: req.mask,
      k: req.opts.k,
      occSumSq: new Float64Array(0),
    };
    const qCodes = new Uint8Array(req.qSab);
    const rcCodes = new Uint8Array(req.rcSab);
    const out = {
      x: new F64Vec(1 << 14),
      y: new F64Vec(1 << 14),
      dx: new F32Vec(1 << 14),
      dy: new F32Vec(1 << 14),
      strand: new U8Vec(1 << 14),
      identity: new F32Vec(1 << 14),
    };
    /** @param {0|1} phase */
    const cb = (phase) => /** @param {number} d @param {number} t */ (d, t) =>
      post({ type: 'progress', part: req.part, phase, done: d, total: t });

    matchStrand(index, qCodes, req.qStarts, req.qTotal, req.tStarts, req.tTotal, req.opts, 0, out, cb(0), req.qLo, req.qHi);
    matchStrand(index, rcCodes, req.rcStarts, req.qTotal, req.tStarts, req.tTotal, req.opts, 1, out, cb(1), req.qLo, req.qHi);

    const seg = {
      count: out.x.n,
      x: out.x.done(),
      y: out.y.done(),
      dx: out.dx.done(),
      dy: out.dy.done(),
      strand: out.strand.done(),
      identity: out.identity.done(),
    };
    post({ type: 'done', part: req.part, seg }, [
      seg.x.buffer,
      seg.y.buffer,
      seg.dx.buffer,
      seg.dy.buffer,
      seg.strand.buffer,
      seg.identity.buffer,
    ]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
