// @ts-check
/**
 * DNA alphabet handling. Bases are packed as 2-bit codes:
 * A=0, C=1, G=2, T/U=3. Anything else (N, IUPAC ambiguity, gaps) is NBASE=4
 * and breaks k-mer windows rather than matching.
 */

export const NBASE = 4;

/** ASCII byte -> 2-bit code (case-insensitive), NBASE for everything else. */
export const CODE = (() => {
  const t = new Uint8Array(256).fill(NBASE);
  t[0x41] = t[0x61] = 0; // A a
  t[0x43] = t[0x63] = 1; // C c
  t[0x47] = t[0x67] = 2; // G g
  t[0x54] = t[0x74] = 3; // T t
  t[0x55] = t[0x75] = 3; // U u (RNA)
  return t;
})();

export const BASE_CHAR = 'ACGTN';

/**
 * Reverse complement of a code array (complement of NBASE stays NBASE).
 * @param {Uint8Array} codes
 * @returns {Uint8Array}
 */
export function reverseComplement(codes) {
  const n = codes.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = codes[n - 1 - i];
    out[i] = c < 4 ? 3 - c : NBASE;
  }
  return out;
}

/**
 * Decode a code array back to an ACGTN string (small slices only — debugging,
 * tests, demo FASTA export).
 * @param {Uint8Array} codes
 * @returns {string}
 */
export function codesToString(codes) {
  let s = '';
  for (let i = 0; i < codes.length; i++) s += BASE_CHAR[codes[i]];
  return s;
}

/**
 * Encode an ACGTN string to codes (tests and demo data).
 * @param {string} s
 * @returns {Uint8Array}
 */
export function stringToCodes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = CODE[s.charCodeAt(i) & 0xff];
  return out;
}
