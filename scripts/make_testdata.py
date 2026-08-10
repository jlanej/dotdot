#!/usr/bin/env python3
"""Generate a synthetic assembly-vs-reference pair for exercising dotdot.

Writes testdata/target.fa and testdata/query.fa (git-ignored), structured so a
dot plot shows: collinear backbone with SNP divergence, a deletion, a large
inversion, a translocation between chromosomes, and an unrelated contig.

Then align with minimap2 and load the PAF in dotdot:

    minimap2 -cx asm20 testdata/target.fa testdata/query.fa > testdata/example.paf
"""
import random
from pathlib import Path

random.seed(0xD07D07)
BASES = 'ACGT'
COMP = str.maketrans('ACGT', 'TGCA')


def rand_seq(n):
    return ''.join(random.choice(BASES) for _ in range(n))


def mutate(s, rate):
    out = []
    for c in s:
        if random.random() < rate:
            out.append(random.choice(BASES.replace(c, '')))
        else:
            out.append(c)
    return ''.join(out)


def revcomp(s):
    return s.translate(COMP)[::-1]


def write_fasta(path, records):
    with open(path, 'w') as fh:
        for name, seq in records:
            fh.write(f'>{name}\n')
            for i in range(0, len(seq), 80):
                fh.write(seq[i:i + 80] + '\n')


def main():
    kb = 1000
    out = Path(__file__).resolve().parent.parent / 'testdata'
    out.mkdir(exist_ok=True)

    chr_a = rand_seq(900 * kb)
    chr_b = rand_seq(600 * kb)

    snp = 0.03  # ~ asm20 territory
    q_chr_a = ''.join([
        mutate(chr_a[0:200 * kb], snp),
        # 80 kb deletion (200k..280k missing)
        mutate(chr_a[280 * kb:500 * kb], snp),
        revcomp(mutate(chr_a[500 * kb:680 * kb], snp)),  # 180 kb inversion
        mutate(chr_b[50 * kb:170 * kb], snp),            # 120 kb translocation
        mutate(chr_a[680 * kb:900 * kb], snp),
    ])
    q_chr_b = mutate(chr_b, 0.05)
    novel = rand_seq(150 * kb)

    write_fasta(out / 'target.fa', [('chrA', chr_a), ('chrB', chr_b)])
    write_fasta(out / 'query.fa', [('chrA_asm', q_chr_a), ('chrB_asm', q_chr_b), ('novel', novel)])
    print('wrote testdata/target.fa and testdata/query.fa')
    print('next: minimap2 -cx asm20 testdata/target.fa testdata/query.fa > testdata/example.paf')


if __name__ == '__main__':
    main()
