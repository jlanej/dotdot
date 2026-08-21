#!/usr/bin/env bash
# Fetch the real-data example used by dotdot's docs: T2T-CHM13v2.0 chr17 and
# the chr17 chromosome sequences of the HPRC Release 2 NA19240 assembly, then
# align them with minimap2. ~135 MB of downloads (ranged requests fetch only
# chr17 from the 1.8 GB assembly files); needs samtools + minimap2 + curl.
#
# Outputs (in testdata/real/; git-ignored except the committed PAF):
#   chr17.fa                      T2T-CHM13v2.0 chr17 (84,276,897 bp)
#   NA19240_hap1_chr17.fa         NA19240#1#CM099585.1 (pat, gapless T2T contig)
#   NA19240_hap2_chr17.fa         NA19240#2#CM099623.1 (mat, 1-gap scaffold)
#   NA19240_chr17.fa              both haplotypes concatenated
#   NA19240_vs_chm13_chr17.paf    minimap2 -cx asm5 alignment
#
# Then open:  /?paf=testdata/real/NA19240_vs_chm13_chr17.paf
#   or:       /?target=testdata/real/chr17.fa&query=testdata/real/NA19240_chr17.fa&k=16
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p testdata/real
cd testdata/real

HPRC="https://s3-us-west-2.amazonaws.com/human-pangenomics/working/HPRC_PLUS/NA19240/assemblies/release2"

echo "== T2T-CHM13v2.0 chr17 (RefSeq NC_060941.1, ~85 MB)"
curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=NC_060941.1&rettype=fasta&retmode=text" \
  | awk 'NR==1{print ">chr17"; next} {print}' > chr17.fa
samtools faidx chr17.fa

echo "== NA19240 HPRC Release 2 chr17 haplotypes (ranged fetch, ~25 MB each)"
samtools faidx "$HPRC/NA19240_pat_hprc_r2_v1.0.1.fa.gz" 'NA19240#1#CM099585.1' \
  | sed '1s/.*/>NA19240.hap1.chr17/' > NA19240_hap1_chr17.fa
samtools faidx "$HPRC/NA19240_mat_hprc_r2_v1.0.1.fa.gz" 'NA19240#2#CM099623.1' \
  | sed '1s/.*/>NA19240.hap2.chr17/' > NA19240_hap2_chr17.fa
cat NA19240_hap1_chr17.fa NA19240_hap2_chr17.fa > NA19240_chr17.fa

echo "== minimap2 asm5 alignment"
minimap2 -t 8 -cx asm5 chr17.fa NA19240_chr17.fa > NA19240_vs_chm13_chr17.paf

echo "done:"
ls -la
