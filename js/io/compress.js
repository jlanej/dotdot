// @ts-check
/**
 * Transparent gzip support via the browser-native DecompressionStream —
 * no library, works in workers, handles multi-hundred-MB files.
 *
 * Real-world genomics gzip is often MULTI-MEMBER: bgzip (BGZF, the blocked
 * gzip of the htslib ecosystem) writes thousands of small members, and plain
 * `cat a.gz b.gz` concatenation is RFC 1952-valid too. DecompressionStream
 * decodes exactly one member and errors on trailing data, so BGZF members
 * are walked explicitly here — each declares its own compressed size (BSIZE)
 * in a gzip FEXTRA subfield, making the walk exact without decompressing to
 * find boundaries.
 */

/** @param {Uint8Array} bytes */
export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Compressed size of the BGZF member starting at `off`, or null when it is
 * not a BGZF-style member (no FEXTRA "BC" subfield).
 * @param {Uint8Array} b @param {number} off
 */
function bgzfMemberSize(b, off) {
  if (off + 18 > b.length) return null;
  if (b[off] !== 0x1f || b[off + 1] !== 0x8b || b[off + 2] !== 8) return null;
  if ((b[off + 3] & 4) === 0) return null; // no FEXTRA field
  const xlen = b[off + 10] | (b[off + 11] << 8);
  let p = off + 12;
  const end = p + xlen;
  if (end > b.length) return null;
  while (p + 4 <= end) {
    const slen = b[p + 2] | (b[p + 3] << 8);
    if (b[p] === 66 && b[p + 1] === 67 && slen === 2 && p + 6 <= end) {
      return (b[p + 4] | (b[p + 5] << 8)) + 1; // BSIZE = total member size - 1
    }
    p += 4 + slen;
  }
  return null;
}

/**
 * Decompress one gzip member.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function gunzipOne(bytes) {
  // Inputs here always wrap plain ArrayBuffers (file reads / fetches, never
  // shared memory); narrow for Blob, which rejects SAB-backed views by type.
  const plain = /** @type {Uint8Array<ArrayBuffer>} */ (bytes);
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Return the input unchanged, or the gunzipped payload when the magic bytes
 * say gzip — including multi-member BGZF (bgzip) files.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function maybeGunzip(bytes) {
  if (!isGzip(bytes)) return bytes;

  if (bgzfMemberSize(bytes, 0) !== null) {
    // BGZF: walk members by declared size, decompressing a batch at a time.
    /** @type {Uint8Array[]} */
    const parts = [];
    /** @type {Uint8Array[]} */
    let batch = [];
    let off = 0;
    while (off < bytes.length) {
      const size = bgzfMemberSize(bytes, off);
      if (size === null || size <= 0 || off + size > bytes.length) {
        throw new Error('Corrupt BGZF block table — re-run bgzip on this file.');
      }
      batch.push(bytes.subarray(off, off + size));
      off += size;
      if (batch.length === 32 || off >= bytes.length) {
        const done = await Promise.all(batch.map(gunzipOne));
        for (const d of done) if (d.length > 0) parts.push(d); // EOF block is empty
        batch = [];
      }
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let w = 0;
    for (const p of parts) {
      out.set(p, w);
      w += p.length;
    }
    return out;
  }

  try {
    return await gunzipOne(bytes);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      'Could not decompress gzip data — the file may be corrupt, or it may be plain ' +
        'concatenated multi-member gzip (not supported; bgzip/BGZF files are). ' +
        `(${detail})`,
    );
  }
}
