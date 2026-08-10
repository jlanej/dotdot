// @ts-check
import { test, assertEq, assertArrayEq } from './harness.js';
import { reverseComplement, stringToCodes, codesToString, CODE, NBASE } from '../js/core/dna.js';

test('dna: encode/decode roundtrip', () => {
  const s = 'ACGTNACGT';
  assertEq(codesToString(stringToCodes(s)), s);
});

test('dna: lowercase and U map correctly', () => {
  assertEq(codesToString(stringToCodes('acgtu')), 'ACGTT');
});

test('dna: ambiguity codes become N', () => {
  assertEq(codesToString(stringToCodes('RYKMSWBDHV-')), 'NNNNNNNNNNN');
  assertEq(CODE['X'.charCodeAt(0)], NBASE);
});

test('dna: reverse complement', () => {
  assertEq(codesToString(reverseComplement(stringToCodes('AACGT'))), 'ACGTT');
  assertEq(codesToString(reverseComplement(stringToCodes('ACGTN'))), 'NACGT');
});

test('dna: double reverse complement is identity', () => {
  const codes = stringToCodes('ATTGCCGNNTAGCA');
  assertArrayEq(reverseComplement(reverseComplement(codes)), codes);
});
