// @ts-check
/**
 * Transparent gzip support via the browser-native DecompressionStream —
 * no library, works in workers, handles multi-hundred-MB files streamed.
 */

/** @param {Uint8Array} bytes */
export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Return the input unchanged, or the gunzipped payload when the magic
 * bytes say gzip.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function maybeGunzip(bytes) {
  if (!isGzip(bytes)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
