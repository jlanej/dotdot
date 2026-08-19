// @ts-check
import { test, assert, assertEq, assertClose } from './harness.js';
import { parsePaf, parsePafOnto, looksLikePaf } from '../js/io/paf.js';

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

test('paf: parsePafOnto maps alignments onto provided axes', () => {
  const target = { names: ['t1', 't2'], starts: new Float64Array([0, 2000, 2500]), total: 2500 };
  const query = { names: ['q1', 'q2'], starts: new Float64Array([0, 1000, 4000]), total: 4000 };
  const r = parsePafOnto(enc.encode(PAF), target, query);
  assertEq(r.segments.count, 3);
  assertEq(r.unknown, 0);
  assertEq(r.skipped, 1);
  // line 1: q1:100 on t1:500, both at offset 0 on their axes
  assertEq(r.segments.x[0], 500);
  assertEq(r.segments.y[0], 100);
  assertEq(r.segments.strand[0], 0);
  // line 2: q2 sits at query offset 1000
  assertEq(r.segments.y[1], 1000);
  assertEq(r.segments.strand[1], 1);
  assertClose(r.segments.identity[1], 250 / 300, 1e-6);
  // line 3: t2 sits at target offset 2000
  assertEq(r.segments.x[2], 2000);
});

test('paf: parsePafOnto drops alignments naming unknown sequences', () => {
  const target = { names: ['t1'], starts: new Float64Array([0, 2000]), total: 2000 };
  const query = { names: ['q1'], starts: new Float64Array([0, 1000]), total: 1000 };
  const r = parsePafOnto(enc.encode(PAF), target, query);
  assertEq(r.segments.count, 1);
  assertEq(r.unknown, 2);
});

test('paf: parsePafOnto throws when nothing matches', () => {
  const target = { names: ['other'], starts: new Float64Array([0, 100]), total: 100 };
  const query = { names: ['nope'], starts: new Float64Array([0, 100]), total: 100 };
  let threw = false;
  try {
    parsePafOnto(enc.encode(PAF), target, query);
  } catch {
    threw = true;
  }
  assert(threw, 'expected a throw');
});

test('paf: parsePafOnto drops extent mismatches instead of misplacing them', () => {
  // t1 claims length 2000 in the PAF; a band of width 800 cannot hold those
  // coordinates — the records must be counted, never drawn at wrong x.
  const target = { names: ['t1', 't2'], starts: new Float64Array([0, 800, 1300]), total: 1300 };
  const query = { names: ['q1', 'q2'], starts: new Float64Array([0, 1000, 4000]), total: 4000 };
  const r = parsePafOnto(enc.encode(PAF), target, query);
  assertEq(r.mismatch, 2);
  assertEq(r.segments.count, 1); // only the t2 record fits (width 500 == len 500)
  assertEq(r.segments.x[0], 800); // t2 band start + local 0
});

test('paf: parsePafOnto remaps genomic-coordinate records onto @offset slices', () => {
  // t1's band is a 400 bp slice starting at genomic 400 (@offset=400). The
  // PAF carries full-chromosome t1 coordinates: 500-600 falls inside the
  // window and lands at local 100. t2's band (width 200, no offset) cannot
  // hold t2's claimed 500 bp extent → mismatch. q2 stays unknown.
  const target = {
    names: ['t1', 't2'],
    starts: new Float64Array([0, 400, 600]),
    total: 600,
    offsets: Float64Array.from([400, 0]),
  };
  const query = { names: ['q1'], starts: new Float64Array([0, 1000]), total: 1000 };
  const r = parsePafOnto(enc.encode(PAF), target, query);
  assertEq(r.segments.count, 1);
  assertEq(r.remapped, 1);
  assertEq(r.mismatch, 1); // the t2 record: claimed len 500 vs band width 200
  assertEq(r.unknown, 1); // the q2 record
  assertEq(r.segments.x[0], 100); // 500 - offset 400
  assertEq(r.segments.y[0], 100); // q1 is slice-local (len matches width)
});
