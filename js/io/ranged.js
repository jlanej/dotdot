// @ts-check
/**
 * Shared HTTP byte-range fetcher for the remote genome formats (2bit,
 * bigBed): CORS mode, a bounded wait so unreachable hosts fail into
 * fallbacks in seconds, and loud failures for servers that ignore Range —
 * this module is the trust boundary, and every reader above it assumes
 * "the bytes I asked for, or a thrown error".
 *
 * Large spans stream in chunks: each chunk is its own range request small
 * enough that the timeout bounds a *stalled host*, never a healthy big
 * download (a whole-chromosome stream is ~60 MB — one flat 20 s timeout
 * used to abort it mid-body). Transient failures retry once; permanent
 * ones (4xx, Range unsupported) fail immediately. A progress callback
 * keeps minutes-long streams visibly alive.
 */

/**
 * Mark an error as not worth retrying (client errors, protocol misuse).
 * @param {string} msg
 */
function permanentError(msg) {
  const err = /** @type {Error & {permanent?: boolean}} */ (new Error(msg));
  err.permanent = true;
  return err;
}

/** @param {unknown} err */
function isPermanent(err) {
  return typeof err === 'object' && err !== null && 'permanent' in err && err.permanent === true;
}

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
    if (res.status === 200) {
      // The server ignored Range and is sending the WHOLE file. Refuse
      // before downloading a possibly-gigabyte body — unless the file is
      // small enough that the whole body is a cheap superset to slice
      // (content-length must be declared and modest).
      const len = Number(res.headers.get('content-length') ?? NaN);
      if (!Number.isFinite(len) || len > Math.max(endEx, 4 * chunkBytes)) {
        throw permanentError(
          `The server for ${url} ignored the Range request (HTTP 200) — byte-range streaming is not possible from it.`,
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      // A 200 body is always the file from byte 0 — never mid-file bytes.
      if (buf.length <= start) {
        throw permanentError(`The file at ${url} is shorter (${buf.length} B) than the requested range start.`);
      }
      return buf.subarray(start, Math.min(endEx, buf.length));
    }
    if (res.status !== 206) {
      const err = new Error(`Remote data server answered HTTP ${res.status} for ${url}`);
      if (res.status >= 400 && res.status < 500) {
        /** @type {Error & {permanent?: boolean}} */ (err).permanent = true;
      }
      throw err;
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  /**
   * One retry across transient hiccups (network, timeout, 5xx, truncation);
   * permanent failures (4xx, no Range support) surface immediately.
   * @param {() => Promise<Uint8Array>} fn
   */
  const withRetry = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (isPermanent(err)) throw err;
      await new Promise((r) => setTimeout(r, 1000));
      return fn();
    }
  };

  return async (start, endEx, onProgress) => {
    const total = endEx - start;
    // Small spans go out as one request. A short 206 body is legitimate
    // here: header probes deliberately over-read past EOF and clamp.
    if (total <= chunkBytes) return withRetry(() => one(start, endEx));
    const out = new Uint8Array(total);
    let w = 0;
    for (let s = start; s < endEx; s += chunkBytes) {
      const e = Math.min(endEx, s + chunkBytes);
      // Chunk spans are always fully inside the caller's request, so a short
      // body is never a legitimate EOF clamp — it is a truncated transfer.
      // Silently zero-filling here would decode as plausible wrong sequence
      // (0x00 = poly-T in 2bit); fail the chunk instead so the retry (and
      // then the caller) sees a loud, actionable error.
      const part = await withRetry(async () => {
        const p = await one(s, e);
        if (p.length !== e - s) {
          throw new Error(
            `Range request returned ${p.length} of ${e - s} bytes — truncated response from the server`,
          );
        }
        return p;
      });
      out.set(part, w);
      w += part.length;
      if (onProgress) onProgress(w, total);
    }
    return out;
  };
}
