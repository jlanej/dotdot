// @ts-check
/**
 * Shared HTTP byte-range fetcher for the remote genome formats (2bit,
 * bigBed): CORS mode, a bounded wait so unreachable hosts fail into
 * fallbacks in seconds, and protection against servers that ignore Range
 * and answer 200 with the whole (possibly gigabyte) file.
 */

/**
 * @param {string} url
 * @returns {(start: number, endEx: number) => Promise<Uint8Array>}
 */
export function makeRangeFetcher(url) {
  return async (start, endEx) => {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${endEx - 1}` },
      mode: 'cors',
      signal: AbortSignal.timeout(20_000),
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
}
