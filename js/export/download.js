// @ts-check
/**
 * Save a Blob to the user's downloads.
 * @param {Blob} blob @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
