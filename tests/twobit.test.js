// @ts-check
import { test, assert, assertEq } from './harness.js';
import { RemoteTwoBit, regionToFasta } from '../js/io/twobit.js';
import { makeRangeFetcher } from '../js/io/ranged.js';
import { parseFasta } from '../js/io/fasta.js';
import { codesToString } from '../js/core/dna.js';

const VAL = { T: 0, C: 1, A: 2, G: 3 };

/**
 * Build an in-memory 2bit file. N runs become N blocks; every sequence gets
 * a dummy mask block so the packed-DNA offset arithmetic is exercised.
 * @param {{name: string, seq: string}[]} seqs
 */
function buildTwoBit(seqs) {
  /** @type {number[]} */
  const bytes = [];
  const w32 = (/** @type {number} */ v) => {
    bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };
  w32(0x1a412743);
  w32(0);
  w32(seqs.length);
  w32(0);

  // index (offsets patched after layout)
  /** @type {number[]} */
  const patchAt = [];
  for (const s of seqs) {
    bytes.push(s.name.length);
    for (const ch of s.name) bytes.push(ch.charCodeAt(0));
    patchAt.push(bytes.length);
    w32(0);
  }

  seqs.forEach((s, si) => {
    const offset = bytes.length;
    const b = bytes;
    const at = patchAt[si];
    b[at] = offset & 0xff;
    b[at + 1] = (offset >>> 8) & 0xff;
    b[at + 2] = (offset >>> 16) & 0xff;
    b[at + 3] = (offset >>> 24) & 0xff;

    const seq = s.seq.toUpperCase();
    w32(seq.length);
    /** @type {[number, number][]} */
    const nBlocks = [];
    for (const m of seq.matchAll(/N+/g)) nBlocks.push([m.index ?? 0, m[0].length]);
    w32(nBlocks.length);
    for (const [st] of nBlocks) w32(st);
    for (const [, len] of nBlocks) w32(len);
    // one dummy mask block — reader must skip it arithmetically
    w32(1);
    w32(0);
    w32(Math.min(2, seq.length));
    w32(0); // reserved
    for (let i = 0; i < seq.length; i += 4) {
      let byte = 0;
      for (let j = 0; j < 4; j++) {
        const ch = seq[i + j] ?? 'T';
        const v = ch === 'N' ? 0 : VAL[/** @type {keyof typeof VAL} */ (ch)];
        byte |= v << ((3 - j) * 2);
      }
      bytes.push(byte);
    }
  });
  return new Uint8Array(bytes);
}

/** @param {Uint8Array} fixture */
function reader(fixture) {
  return new RemoteTwoBit('mem://fixture', {
    fetchRange: async (s, e) => fixture.subarray(s, Math.min(e, fixture.length)),
  });
}

const ALPHA = 'ACGTACGTNNNNACGTAC';
const BETA = 'TTTTCCCCAAAAGGGGT';
const FIXTURE = buildTwoBit([
  { name: 'alpha', seq: ALPHA },
  { name: 'beta', seq: BETA },
]);

test('twobit: index lists sequences in order', async () => {
  const tb = reader(FIXTURE);
  const names = await tb.names();
  assertEq(names.join(','), 'alpha,beta');
});

test('twobit: seqMeta reads sizes and N blocks', async () => {
  const tb = reader(FIXTURE);
  const meta = await tb.seqMeta('alpha');
  assertEq(meta.dnaSize, ALPHA.length);
  assertEq(meta.nBlocks.length, 1);
  assertEq(meta.nBlocks[0][0], 8);
  assertEq(meta.nBlocks[0][1], 4);
});

test('twobit: full-sequence fetch reproduces the input (N applied)', async () => {
  const tb = reader(FIXTURE);
  const a = new TextDecoder().decode(await tb.fetchRegion('alpha', 0, ALPHA.length));
  assertEq(a, ALPHA);
  const b = new TextDecoder().decode(await tb.fetchRegion('beta', 0, BETA.length));
  assertEq(b, BETA);
});

test('twobit: sub-regions at every byte phase', async () => {
  const tb = reader(FIXTURE);
  for (let start = 0; start < 6; start++) {
    for (const end of [start + 1, start + 5, ALPHA.length]) {
      const got = new TextDecoder().decode(await tb.fetchRegion('alpha', start, end));
      assertEq(got, ALPHA.slice(start, end), `alpha[${start},${end})`);
    }
  }
});

test('twobit: region partially overlapping an N block', async () => {
  const tb = reader(FIXTURE);
  const got = new TextDecoder().decode(await tb.fetchRegion('alpha', 6, 14));
  assertEq(got, ALPHA.slice(6, 14));
});

test('twobit: unknown sequence throws', async () => {
  const tb = reader(FIXTURE);
  let threw = false;
  try {
    await tb.fetchRegion('gamma', 0, 10);
  } catch {
    threw = true;
  }
  assert(threw, 'expected a throw');
});

test('twobit: regionToFasta round-trips through parseFasta with offsets', async () => {
  const tb = reader(FIXTURE);
  const bases = await tb.fetchRegion('beta', 4, 16);
  const fasta = regionToFasta('beta', 'test beta:5-16 @stuff', 4, bases);
  const parsed = parseFasta(fasta);
  assertEq(parsed.catalog.names[0], 'beta');
  assert(parsed.catalog.offsets !== undefined, 'offsets present');
  assertEq(/** @type {Float64Array} */ (parsed.catalog.offsets)[0], 4);
  assertEq(codesToString(parsed.codes), 'CCCCAAAAGGGG');
});

test('ranged: large spans stream in chunks with progress and one retry', async () => {
  const FILE = new Uint8Array(5000);
  for (let i = 0; i < FILE.length; i++) FILE[i] = i & 0xff;
  /** @type {string[]} */
  const ranges = [];
  let failedOnce = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (
    async (/** @type {any} */ _url, /** @type {any} */ init) => {
      const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
      if (!m) throw new Error('no Range header');
      const s = Number(m[1]);
      const e = Number(m[2]) + 1;
      ranges.push(`${s}-${e}`);
      if (s === 2000 && !failedOnce) {
        failedOnce = true;
        throw new Error('transient network hiccup');
      }
      return new Response(FILE.slice(s, e), { status: 206 });
    }
  );
  try {
    const fetchRange = makeRangeFetcher('http://example.test/genome.2bit', 1000);
    /** @type {number[]} */
    const prog = [];
    const out = await fetchRange(0, 5000, (d) => prog.push(d));
    assertEq(out.length, 5000);
    let ok = true;
    for (let i = 0; i < 5000; i++) {
      if (out[i] !== (i & 0xff)) {
        ok = false;
        break;
      }
    }
    assert(ok, 'bytes reassembled in order across chunks');
    assertEq(prog.join(','), '1000,2000,3000,4000,5000');
    assert(failedOnce, 'the transient failure was hit');
    assertEq(ranges.filter((r) => r === '2000-3000').length, 2); // retried once
    // Small spans stay one request (the historical fast path).
    ranges.length = 0;
    await fetchRange(0, 500);
    assertEq(ranges.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('twobit: non-zero version is refused by name', async () => {
  const fx = buildTwoBit([{ name: 'c', seq: 'ACGT' }]).slice();
  fx[4] = 1; // version 1 stores 64-bit offsets — a different layout
  let msg = '';
  try {
    await reader(fx).index();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  assert(msg.includes('version 1'), `expected a version error, got: ${msg}`);
});

test('ranged: a truncated chunk body fails loudly after one retry', async () => {
  const FILE = new Uint8Array(3000);
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = /** @type {any} */ (
    async (/** @type {any} */ _url, /** @type {any} */ init) => {
      const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
      if (!m) throw new Error('no Range header');
      const s = Number(m[1]);
      const e = Number(m[2]) + 1;
      calls++;
      // The middle chunk always comes back 100 bytes short — a truncated
      // transfer that must never silently zero-fill into "sequence".
      const body = s === 1000 ? FILE.slice(s, e - 100) : FILE.slice(s, e);
      return new Response(body, { status: 206 });
    }
  );
  try {
    const fetchRange = makeRangeFetcher('http://example.test/x.2bit', 1000);
    let msg = '';
    try {
      await fetchRange(0, 3000);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    assert(msg.includes('truncated'), `expected a truncation error, got: ${msg}`);
    assertEq(calls, 3); // first chunk once, the bad chunk tried twice
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ranged: a 200 whole-file answer is sliced from byte 0, never treated as mid-file bytes', async () => {
  const FILE = Uint8Array.from({ length: 500 }, (_, i) => i & 0xff);
  const origFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (
    async () =>
      new Response(FILE, { status: 200, headers: { 'content-length': String(FILE.length) } })
  );
  try {
    const fetchRange = makeRangeFetcher('http://example.test/small.bb', 1000);
    const out = await fetchRange(100, 200);
    assertEq(out.length, 100);
    assertEq(out[0], 100); // file byte 100 — the old code returned byte 0 here
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ranged: a Range-ignoring server on a big file is refused up front', async () => {
  const origFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = /** @type {any} */ (
    async () => {
      calls++;
      return new Response(new Uint8Array(10), {
        status: 200,
        headers: { 'content-length': String(5e9) },
      });
    }
  );
  try {
    const fetchRange = makeRangeFetcher('http://example.test/big.bb', 1000);
    let msg = '';
    try {
      await fetchRange(4000, 8000);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    // Either refusal is correct (impls differ on whether the constructed
    // content-length survives); the guarantee is no mid-file mis-slice and
    // no full-body download loop.
    assert(/ignored the Range|shorter \(/.test(msg), msg);
    assertEq(calls, 1); // permanent error: no retry
  } finally {
    globalThis.fetch = origFetch;
  }
});
