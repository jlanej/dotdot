// @ts-check
/**
 * Deterministic synthetic genome pair for the demo button. The query is a
 * restructured, mutated copy of the target so the plot shows every classic
 * dot-plot signature at once: a broken main diagonal (deletion), an
 * inversion (anti-diagonal), a translocation between chromosomes, a tandem
 * repeat block, an inverted duplication, and an unrelated contig.
 */
import { reverseComplement } from '../core/dna.js';

/** Deterministic 32-bit PRNG. @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} n @param {() => number} rng
 */
function randCodes(n, rng) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 4) | 0;
  return out;
}

/**
 * Copy with SNPs at `rate` (always substitutes to a different base).
 * @param {Uint8Array} codes @param {number} rate @param {() => number} rng
 */
function mutate(codes, rate, rng) {
  const out = codes.slice();
  for (let i = 0; i < out.length; i++) {
    if (rng() < rate) out[i] = (out[i] + 1 + ((rng() * 3) | 0)) & 3;
  }
  return out;
}

/** @param {Uint8Array[]} parts */
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * @returns {{
 *   tCodes: Uint8Array, tNames: string[], tLens: number[],
 *   qCodes: Uint8Array, qNames: string[], qLens: number[],
 * }}
 */
export function makeDemo() {
  const rng = mulberry32(0xd07d07);
  const kb = 1000;

  const chrA = randCodes(800 * kb, rng);
  const chrB = randCodes(500 * kb, rng);
  const plasmid = randCodes(80 * kb, rng);

  const snp = 0.012;
  /** @param {Uint8Array} c @param {number} s @param {number} e */
  const seg = (c, s, e) => mutate(c.subarray(s, e), snp, rng);

  // qChrA — everything happens to chromosome A:
  const tandemUnit = chrA.subarray(700 * kb, 705 * kb);
  const tandem = concat(Array.from({ length: 12 }, () => mutate(tandemUnit, 0.02, rng)));
  const qChrA = concat([
    seg(chrA, 0, 150 * kb),                                   // collinear
    // 90 kb deletion: chrA 150k..240k missing from the query
    seg(chrA, 240 * kb, 450 * kb),                            // collinear
    reverseComplement(seg(chrA, 450 * kb, 630 * kb)),         // 180 kb inversion
    seg(chrA, 630 * kb, 700 * kb),                            // collinear
    mutate(chrB.subarray(100 * kb, 240 * kb), snp, rng),      // 140 kb translocation from chrB
    tandem,                                                   // 60 kb tandem repeat block
    seg(chrA, 700 * kb, 800 * kb),                            // collinear tail
  ]);

  // qChrB — mutated copy plus an inverted duplication of its own head:
  const qChrB = concat([
    mutate(chrB, 0.02, rng),
    reverseComplement(mutate(chrB.subarray(0, 100 * kb), 0.02, rng)),
  ]);

  // Unrelated contig — should stay empty in the plot:
  const qNovel = randCodes(200 * kb, rng);

  return {
    tCodes: concat([chrA, chrB, plasmid]),
    tNames: ['chrA', 'chrB', 'plasmid'],
    tLens: [chrA.length, chrB.length, plasmid.length],
    qCodes: concat([qChrA, qChrB, qNovel]),
    qNames: ['chrA_asm', 'chrB_asm', 'novel_contig'],
    qLens: [qChrA.length, qChrB.length, qNovel.length],
  };
}
