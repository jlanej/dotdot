// @ts-check
/**
 * Shared HTTP byte-range fetcher for the remote genome formats (2bit,
 * bigBed): CORS mode, a bounded wait so unreachable hosts fail into
 * fallbacks in seconds, and protection against servers that ignore Range
 * and answer 200 with the whole (possibly gigabyte) file.
 *
 * Large spans stream in chunks: each chunk is its own range request small
 * enough that the timeout bounds a *stalled host*, never a healthy big
 * download (a whole-chromosome stream is ~60 MB — one flat 20 s timeout
 * used to abort it mid-body). Chunks retry once across transient hiccups,
 * and a progress callback keeps minutes-long streams visibly alive.
 */

/**
 * @param {string} url
 * @param {number} [chunkBytes] range-request size for large spans
 * @returns {(start: number, endEx: number, onProgress?: (doneBytes: number, totalBytes: number) => void) => Promise<Uint8Array>}
 */
export function makeRangeFetcher(url, chunkBytes = 8 * 1024 * 1024) {
  /**
   * One bounded range request.
   * @param {number} start @param {number} endEx
   * @returns {Promise<Uint8Array>}
   */
  const one = async (start, endEx) => {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${endEx - 1}` },
      mode: 'cors',
      signal: AbortSignal.timeout(25_000),
    });
    if (!(res.status === 206 || res.status === 200)) {
      throw new Error(`Remote data server answered HTTP ${res.status} for ${url}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (res.status === 200 && buf.length > endEx - start) {
      return buf.subarray(start, endEx);
    }
    return buf;
  };

  return async (start, endEx, onProgress) => {
    const total = endEx - start;
    if (total <= chunkBytes) return one(start, endEx);
    const out = new Uint8Array(total);
    let w = 0;
    for (let s = start; s < endEx; s += chunkBytes) {
      const e = Math.min(endEx, s + chunkBytes);
      // Chunk spans are always fully inside the caller's request, so a short
      // body is never a legitimate EOF clamp — it is a truncated transfer.
      // Silently zero-filling here would decode as plausible wrong sequence
      // (0x00 = poly-T in 2bit); fail the chunk instead so the retry (and
      // then the caller) sees a loud, actionable error.
      const oneExact = async () => {
        const part = await one(s, e);
        if (part.length !== e - s) {
          throw new Error(
            `Range request returned ${part.length} of ${e - s} bytes — truncated response from the server`,
          );
        }
        return part;
      };
      /** @type {Uint8Array} */
      let part;
      try {
        part = await oneExact();
      } catch {
        // One retry per chunk: a 60 MB stream should survive a transient
        // hiccup without starting over.
        await new Promise((r) => setTimeout(r, 1000));
        part = await oneExact();
      }
      out.set(part, w);
      w += part.length;
      if (onProgress) onProgress(w, total);
    }
    return out;
  };
}
