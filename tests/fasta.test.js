// @ts-check
import { test, assert, assertEq, assertArrayEq } from './harness.js';
import { parseFasta, looksLikeFasta } from '../js/io/fasta.js';
import { codesToString } from '../js/core/dna.js';

const enc = new TextEncoder();

test('fasta: multi-record with CRLF, lowercase, blank lines', () => {
  const txt = '>chr1 assembly=demo\r\nACGT\r\nacgt\r\n\r\n>chr2\r\nTTNN\r\n';
  const { catalog, codes } = parseFasta(enc.encode(txt));
  assertArrayEq(catalog.names.map((n) => n.length), ['chr1'.length, 'chr2'.length]);
  assertEq(catalog.names[0], 'chr1');
  assertEq(catalog.names[1], 'chr2');
  assertArrayEq(Array.from(catalog.starts), [0, 8, 12]);
  assertEq(catalog.total, 12);
  assertEq(codesToString(codes), 'ACGTACGTTTNN');
});

test('fasta: header name stops at whitespace, description dropped', () => {
  const { catalog } = parseFasta(enc.encode('>seqX\tsome description here\nAAAA\n'));
  assertEq(catalog.names[0], 'seqX');
});

test('fasta: headerless plain sequence', () => {
  const { catalog, codes } = parseFasta(enc.encode('ACGTACGT'), 'raw');
  assertEq(catalog.names[0], 'raw');
  assertEq(codes.length, 8);
});

test('fasta: no trailing newline', () => {
  const { codes } = parseFasta(enc.encode('>s\nACG'));
  assertEq(codesToString(codes), 'ACG');
});

test('fasta: empty input throws', () => {
  let threw = false;
  try {
    parseFasta(enc.encode('>onlyheader\n'));
  } catch {
    threw = true;
  }
  assert(threw, 'expected a throw');
});

test('fasta: sniffing', () => {
  assert(looksLikeFasta(enc.encode('\n\n>abc\nACGT')));
  assert(!looksLikeFasta(enc.encode('q\t1\t2\t3')));
});
