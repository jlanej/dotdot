// @ts-check
/**
 * Remote 2bit reader — the same random-access genome format UCSC's own
 * browser uses. Byte-range requests fetch only what a region needs: the
 * ~16-byte header and sequence index once, a few dozen bytes of per-sequence
 * metadata on first touch, then ceil(len/4) bytes of packed DNA per region.
 * A 3 Mb centromere costs ~750 kB of transfer; the genome itself never
 * downloads.
 *
 * Format (little-endian, version 0):
 *   header: signature 0x1A412743, version, sequenceCount, reserved
 *   index:  per sequence: nameSize u8, name bytes, offset u32
 *   record: dnaSize u32, nBlockCount u32, nBlockStarts[], nBlockSizes[],
 *           maskBlockCount u32, maskStarts[], maskSizes[], reserved u32,
 *           packed DNA (2 bits/base, T C A G = 0 1 2 3, first base in the
 *           byte's high bits)
 */

const SIGNATURE = 0x1a412743;
const BASE_ASCII = new Uint8Array([84, 67, 65, 71]); // T C A G
const ASCII_N = 78;

// byte -> its 4 decoded bases, built once: turns the per-base shift/mask
// decode into four table writes per packed byte (matters at 100 Mb regions).
const BYTE_BASES = (() => {
  const t = new Uint8Array(256 * 4);
  for (let b = 0; b < 256; b++) {
    for (let j = 0; j < 4; j++) t[b * 4 + j] = BASE_ASCII[(b >> ((3 - j) * 2)) & 3];
  }
  return t;
})();

/**
 * @typedef {Object} SeqMeta
 * @property {number} dnaSize
 * @property {number} dnaOffset byte offset of the packed DNA
 * @property {[number, number][]} nBlocks [start, size] pairs
 */

export class RemoteTwoBit {
  /**
   * @param {string} url
   * @param {{fetchRange?: (start: number, endEx: number) => Promise<Uint8Array>}} [io]
   *   injectable transport (tests provide an in-memory fixture)
   */
  constructor(url, io = {}) {
    this.url = url;
    this.fetchRange = io.fetchRange ?? this.httpRange.bind(this);
    /** @type {Map<string, number> | null} name -> record offset */
    this.offsets = null;
    /** @type {Map<string, SeqMeta>} */
    this.meta = new Map();
  }

  /**
   * @param {number} start @param {number} endEx
   * @returns {Promise<Uint8Array>}
   */
  async httpRange(start, endEx) {
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${endEx - 1}` },
      mode: 'cors',
    });
    if (!(res.status === 206 || res.status === 200)) {
      throw new Error(`Reference server answered HTTP ${res.status} for ${this.url}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // A 200 means the server ignored Range — protect against pulling 800 MB.
    if (res.status === 200 && buf.length > endEx - start) {
      return buf.subarray(start, endEx);
    }
    return buf;
  }

  /** Parse the header + sequence index (cached). */
  async index() {
    if (this.offsets) return this.offsets;
    let size = 64 * 1024;
    for (;;) {
      const bytes = await this.fetchRange(0, size);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (dv.getUint32(0, true) !== SIGNATURE) {
        throw new Error('Not a little-endian 2bit file (bad signature).');
      }
      const count = dv.getUint32(8, true);
      /** @type {Map<string, number>} */
      const offsets = new Map();
      let p = 16;
      let ok = true;
      const td = new TextDecoder();
      for (let i = 0; i < count; i++) {
        if (p + 1 > bytes.length) { ok = false; break; }
        const nameSize = bytes[p];
        if (p + 1 + nameSize + 4 > bytes.length) { ok = false; break; }
        const name = td.decode(bytes.subarray(p + 1, p + 1 + nameSize));
        offsets.set(name, dv.getUint32(p + 1 + nameSize, true));
        p += 1 + nameSize + 4;
      }
      if (ok) {
        this.offsets = offsets;
        return offsets;
      }
      if (size > 8 * 1024 * 1024) throw new Error('2bit index unexpectedly large.');
      size *= 4;
    }
  }

  /** Sequence names in file order. */
  async names() {
    return [...(await this.index()).keys()];
  }

  /**
   * Per-sequence metadata (cached): size, N blocks, packed-DNA offset.
   * @param {string} name
   * @returns {Promise<SeqMeta>}
   */
  async seqMeta(name) {
    const cached = this.meta.get(name);
    if (cached) return cached;
    const offsets = await this.index();
    const rec = offsets.get(name);
    if (rec === undefined) throw new Error(`Sequence "${name}" is not in this reference.`);

    const head = await this.fetchRange(rec, rec + 8);
    const dvh = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const dnaSize = dvh.getUint32(0, true);
    const nBlockCount = dvh.getUint32(4, true);
    if (nBlockCount > 10_000_000) throw new Error('Implausible 2bit N-block count.');

    // N-block arrays plus the mask-block count in one fetch; the mask arrays
    // themselves are skipped arithmetically (we ignore soft-masking).
    const nbBytes = await this.fetchRange(rec + 8, rec + 8 + 8 * nBlockCount + 4);
    const dvn = new DataView(nbBytes.buffer, nbBytes.byteOffset, nbBytes.byteLength);
    /** @type {[number, number][]} */
    const nBlocks = [];
    for (let i = 0; i < nBlockCount; i++) {
      nBlocks.push([dvn.getUint32(i * 4, true), dvn.getUint32(nBlockCount * 4 + i * 4, true)]);
    }
    const maskBlockCount = dvn.getUint32(8 * nBlockCount, true);
    const dnaOffset = rec + 8 + 8 * nBlockCount + 4 + 8 * maskBlockCount + 4;

    /** @type {SeqMeta} */
    const meta = { dnaSize, dnaOffset, nBlocks };
    this.meta.set(name, meta);
    return meta;
  }

  /**
   * Fetch [start, end) of a sequence as uppercase ASCII bases (ACGTN).
   * @param {string} name @param {number} start @param {number} end 0-based half-open
   * @returns {Promise<Uint8Array>}
   */
  async fetchRegion(name, start, end) {
    const meta = await this.seqMeta(name);
    const s = Math.max(0, Math.floor(start));
    const e = Math.min(meta.dnaSize, Math.ceil(end));
    if (e <= s) throw new Error(`Empty region ${name}:${start}-${end} (length ${meta.dnaSize}).`);

    const byteA = meta.dnaOffset + (s >> 2);
    const byteB = meta.dnaOffset + ((e - 1) >> 2) + 1;
    const packed = await this.fetchRange(byteA, byteB);

    const out = new Uint8Array(e - s);
    const b0 = s >> 2;
    let i = s;
    // Head: bases before the first whole packed byte.
    while (i < e && (i & 3) !== 0) {
      out[i - s] = BASE_ASCII[(packed[(i >> 2) - b0] >> ((3 - (i & 3)) * 2)) & 3];
      i++;
    }
    // Middle: whole bytes, four bases per table hit.
    let w = i - s;
    for (const mEnd = e - 3; i < mEnd; i += 4, w += 4) {
      const o4 = packed[(i >> 2) - b0] * 4;
      out[w] = BYTE_BASES[o4];
      out[w + 1] = BYTE_BASES[o4 + 1];
      out[w + 2] = BYTE_BASES[o4 + 2];
      out[w + 3] = BYTE_BASES[o4 + 3];
    }
    // Tail: the final partial byte.
    for (; i < e; i++) {
      out[i - s] = BASE_ASCII[(packed[(i >> 2) - b0] >> ((3 - (i & 3)) * 2)) & 3];
    }
    for (const [bs, size] of meta.nBlocks) {
      const a = Math.max(bs, s);
      const b = Math.min(bs + size, e);
      for (let i = a; i < b; i++) out[i - s] = ASCII_N;
    }
    return out;
  }
}

/**
 * Wrap a fetched region as an in-memory FASTA record. The `@offset=` token
 * in the description survives every re-parse (including Refine view's), so
 * hover, readout, and the region box speak true genomic coordinates.
 *
 * @param {string} recordName
 * @param {string} description e.g. "T2T-CHM13v2.0 chrX:57,820,001-60,670,000"
 * @param {number} offset0 0-based genomic coordinate of the region's first base
 * @param {Uint8Array} bases ASCII
 * @returns {Uint8Array<ArrayBuffer>} FASTA bytes
 */
export function regionToFasta(recordName, description, offset0, bases) {
  const header = `>${recordName} ${description} @offset=${offset0}\n`;
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.length + bases.length + 1);
  out.set(head, 0);
  out.set(bases, head.length);
  out[out.length - 1] = 10;
  return out;
}
