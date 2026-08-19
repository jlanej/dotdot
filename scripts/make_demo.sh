#!/usr/bin/env bash
# Regenerate testdata/demo/ (the "Demo: chr17 loci" dataset) from testdata/real/.
#
# Inputs (produced by scripts/fetch_realdata.sh):
#   testdata/real/chr17.fa                    T2T-CHM13v2.0 chr17 (RefSeq-derived)
#   testdata/real/NA19240_hap{1,2}_chr17.fa   HPRC r2 NA19240 haplotype chr17s
#
# Outputs (only the .gz and the .paf are committed; raw .fa are gitignored):
#   testdata/demo/target.fa[.gz]    chr17 slices with @offset= true coordinates
#   testdata/demo/query.fa[.gz]     matching NA19240 haplotype slices
#   testdata/demo/minimap2_demo.paf audit-overlay alignments (local record coords)
#
# The target slices are exact coordinate cuts, so the committed fallback is
# parse-identical to what the app streams live from the UCSC 2bit at the same
# coordinates — same records, names, and @offset tokens; only line wrapping
# differs (js/main.js loadDemo must use the same LOCI ranges below).
set -euo pipefail
cd "$(dirname "$0")/.."

REAL=testdata/real
DEMO=testdata/demo
PAD=30000 # flank around the mapped haplotype interval

# locus-suffix  chr17-start(1-based)  chr17-end(inclusive)
LOCI=(
  "17p11.2 18000001 19600000"
  "ROI10.9 10600001 11200000"
)

for f in chr17.fa chr17.fa.fai NA19240_hap1_chr17.fa NA19240_hap2_chr17.fa; do
  [ -s "$REAL/$f" ] || { echo "missing $REAL/$f — run scripts/fetch_realdata.sh first" >&2; exit 1; }
done
mkdir -p "$DEMO"
LOG=$(mktemp)
SLICE=$(mktemp)
trap 'rm -f "$LOG" "$SLICE"' EXIT

fmt() { python3 -c "print(f'{int('"$1"'):,}')"; }
seq_body() { tail -n +2 | tr -d '\n' | fold -w 60; }

: > "$DEMO/target.fa"
: > "$DEMO/query.fa"

for locus in "${LOCI[@]}"; do
  read -r SUF A B <<<"$locus"
  echo "== ${SUF} chr17:${A}-${B} ($(((B - A + 1) / 1000)) kb)" >&2

  # Target: an exact chr17 cut in the app's own streamed-header format.
  {
    echo ">chr17_${SUF} T2T-CHM13v2.0 chr17:$(fmt "$A")-$(fmt "$B") @offset=$((A - 1))"
    samtools faidx "$REAL/chr17.fa" "chr17:${A}-${B}" | seq_body
    echo
  } >> "$DEMO/target.fa"
  samtools faidx "$REAL/chr17.fa" "chr17:${A}-${B}" > "$SLICE"

  # hapN  hap-label  original-assembly-contig (for the description only)
  for hap in "1 pat CM099585.1" "2 mat CM099623.1"; do
    read -r N LABEL CONTIG <<<"$hap"
    FA="$REAL/NA19240_hap${N}_chr17.fa"
    NAME=$(cut -f1 "$FA.fai")
    # Map the slice onto the haplotype; the mapq>=40 primary alignments
    # bound the corresponding interval, padded by PAD and clamped.
    read -r HA HB <<<"$(
      minimap2 -x asm5 "$FA" "$SLICE" 2>>"$LOG" |
        awk -v pad="$PAD" '
          $12 >= 40 { if (min == "" || $8 < min) min = $8; if ($9 > max) max = $9; len = $7 }
          END {
            if (min == "") exit 1
            a = min + 1 - pad; if (a < 1) a = 1
            b = max + pad; if (b > len) b = len
            print a, b
          }'
    )"
    {
      echo ">NA19240.hap${N}_${SUF} HPRC_r2 ${LABEL} ${CONTIG}:$(fmt "$HA")-$(fmt "$HB") @offset=$((HA - 1))"
      samtools faidx "$FA" "${NAME}:${HA}-${HB}" | seq_body
      echo
    } >> "$DEMO/query.fa"
    echo "   hap${N} ${NAME}:${HA}-${HB} ($(((HB - HA + 1) / 1000)) kb)" >&2
  done
done

minimap2 -cx asm5 "$DEMO/target.fa" "$DEMO/query.fa" 2>>"$LOG" > "$DEMO/minimap2_demo.paf"

gzip -9 -c "$DEMO/target.fa" > "$DEMO/target.fa.gz"
gzip -9 -c "$DEMO/query.fa" > "$DEMO/query.fa.gz"

echo "== alignments: $(grep -c '^' "$DEMO/minimap2_demo.paf")" >&2
grep '^>' "$DEMO/target.fa" "$DEMO/query.fa" >&2
ls -l "$DEMO"/*.gz "$DEMO"/*.paf >&2
