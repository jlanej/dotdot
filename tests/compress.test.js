// @ts-check
import { test, assert, assertEq } from './harness.js';
import { isGzip, maybeGunzip } from '../js/io/compress.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @param {Uint8Array} payload one gzip member via the native compressor */
async function gzipMember(payload) {
  const plain = /** @type {Uint8Array<ArrayBuffer>} */ (payload);
  const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Convert a plain gzip member into a BGZF-style member by injecting the
 * FEXTRA "BC" subfield carrying the member's total compressed size.
 * @param {Uint8Array} member
 */
function bgzfify(member) {
  if ((member[3] & 4) !== 0) throw new Error('fixture: member already has FEXTRA');
  const out = new Uint8Array(member.length + 8);
  out.set(member.subarray(0, 10), 0);
  out[3] = member[3] | 4; // FEXTRA
  out[10] = 6; // XLEN lo
  out[11] = 0; // XLEN hi
  out[12] = 66; // 'B'
  out[13] = 67; // 'C'
  out[14] = 2; // SLEN lo
  out[15] = 0; // SLEN hi
  const bsize = out.length - 1;
  out[16] = bsize & 0xff;
  out[17] = (bsize >> 8) & 0xff;
  out.set(member.subarray(10), 18);
  return out;
}

/** @param {Uint8Array[]} arrays */
function concat(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let w = 0;
  for (const a of arrays) {
    out.set(a, w);
    w += a.length;
  }
  return out;
}

test('compress: non-gzip input passes through untouched', async () => {
  const raw = enc.encode('>s\nACGT\n');
  assert(!isGzip(raw));
  assertEq(await maybeGunzip(raw), raw);
});

test('compress: single-member gzip round-trips', async () => {
  const payload = enc.encode('ACGT'.repeat(500));
  const gz = await gzipMember(payload);
  assert(isGzip(gz));
  assertEq(dec.decode(await maybeGunzip(gz)), dec.decode(payload));
});

test('compress: BGZF multi-member (bgzip-style) is walked and concatenated', async () => {
  const p1 = enc.encode('>a desc\n' + 'ACGT'.repeat(400) + '\n');
  const p2 = enc.encode('>b\n' + 'TTTTCCCC'.repeat(200) + '\n');
  const eof = new Uint8Array(0); // bgzip's trailing empty EOF block
  const file = concat([
    bgzfify(await gzipMember(p1)),
    bgzfify(await gzipMember(p2)),
    bgzfify(await gzipMember(eof)),
  ]);
  const out = await maybeGunzip(file);
  assertEq(dec.decode(out), dec.decode(p1) + dec.decode(p2));
});

test('compress: plain concatenated gzip fails with a multi-member hint', async () => {
  const file = concat([
    await gzipMember(enc.encode('AAAA'.repeat(100))),
    await gzipMember(enc.encode('CCCC'.repeat(100))),
  ]);
  let msg = '';
  try {
    await maybeGunzip(file);
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  assert(/multi-member/.test(msg), `expected multi-member hint, got: ${msg}`);
});

test('compress: truncated BGZF block table throws corrupt, not garbage', async () => {
  const whole = bgzfify(await gzipMember(enc.encode('ACGTACGTACGT')));
  const truncated = whole.subarray(0, whole.length - 4);
  let threw = false;
  try {
    await maybeGunzip(truncated);
  } catch {
    threw = true;
  }
  assert(threw, 'expected a throw');
});
