// @ts-check
import { test, assert, assertEq, assertClose } from './harness.js';
import { parsePaf, looksLikePaf } from '../js/io/paf.js';

const enc = new TextEncoder();

const PAF =
  'q1\t1000\t100\t200\t+\tt1\t2000\t500\t600\t95\t100\t60\n' +
  'q2\t3000\t0\t300\t-\tt1\t2000\t1000\t1300\t250\t300\t60\ttp:A:P\tcm:i:12\n' +
  'garbage line without tabs\n' +
  '# a comment\n' +
  'q1\t1000\t900\t1000\t+\tt2\t500\t0\t100\t100\t100\t60\n';

test('paf: parses records, skips malformed', () => {
  const d = parsePaf(enc.encode(PAF));
  assertEq(d.segments.count, 3);
  assertEq(d.stats.skippedLines, 1);
  assertEq(d.source, 'paf');
});

test('paf: axis catalogs sorted by descending length with offsets', () => {
  const d = parsePaf(enc.encode(PAF));
  assertEq(d.query.names[0], 'q2'); // 3000 > 1000
  assertEq(d.query.names[1], 'q1');
  assertEq(d.query.total, 4000);
  assertEq(d.target.names[0], 't1');
  assertEq(d.target.total, 2500);
  // q1 record: global y = offset(q1)=3000 + 100
  assertEq(d.segments.y[0], 3100);
  assertEq(d.segments.x[0], 500);
  assertEq(d.segments.dx[0], 100);
});

test('paf: strand and identity', () => {
  const d = parsePaf(enc.encode(PAF));
  assertEq(d.segments.strand[0], 0);
  assertEq(d.segments.strand[1], 1);
  assertClose(d.segments.identity[0], 0.95, 1e-6);
  assertClose(d.segments.identity[1], 250 / 300, 1e-6);
  assertClose(d.stats.identMin, 250 / 300, 1e-6);
});

test('paf: t2 alignment lands on its own axis band', () => {
  const d = parsePaf(enc.encode(PAF));
  // t2 (len 500) sorts after t1 (2000): offset 2000
  assertEq(d.segments.x[2], 2000);
});

test('paf: empty and garbage inputs throw', () => {
  for (const s of ['', 'not\ta\tpaf']) {
    let threw = false;
    try {
      parsePaf(enc.encode(s));
    } catch {
      threw = true;
    }
    assert(threw, `expected throw for ${JSON.stringify(s)}`);
  }
});

test('paf: sniffing', () => {
  assert(looksLikePaf(enc.encode(PAF)));
  assert(!looksLikePaf(enc.encode('>chr1\nACGT\n')));
});
