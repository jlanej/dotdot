// @ts-check
/**
 * The help system: one HELP text registry, one shared popover, a "?" button
 * on every control. Clicks are handled at the document level in capture
 * phase (the buttons sit beside form labels — the click must not reach the
 * control underneath); Escape/outside-click/scroll/resize all close it.
 * Zero coupling to app state — initHelp() wires everything once the DOM is
 * parsed, and main's Escape handler calls closeHelp().
 */


const HELP = {
  controls:
    '<b>Mouse / trackpad</b><br>drag — pan · two-finger scroll or wheel — zoom (Alt = x-only) · ' +
    'pinch — zoom (Safari/Chrome; some browsers reserve pinch for page magnification — use the ' +
    'on-plot +/− buttons there) · shift-drag — box zoom · double-click — zoom in (shift = out) · ' +
    'hover — inspect a match<br><b>Keys</b><br>' +
    '<kbd>R</kbd>/<kbd>0</kbd> fit · <kbd>F</kbd> refine view · <kbd>[</kbd>/<kbd>]</kbd> min ' +
    'segment length down/up · <kbd>G</kbd> region box · <kbd>+</kbd>/<kbd>−</kbd> zoom · ' +
    'arrows pan · <kbd>1</kbd>/<kbd>2</kbd> strand toggles · <kbd>P</kbd> fps meter',
  data:
    'Target FASTA = x axis, query FASTA = y axis (one file → self-plot). Each button ' +
    '<b>multi-selects</b>: several files stack onto that axis as one plot, every sequence keeping ' +
    'its own ruler, with alternating shading separating regions. Drop 3+ FASTAs at once and the ' +
    'first becomes the target, the rest the query. dotdot computes matches itself, ' +
    'alignment-free; gzipped (and bgzip) files are fine.',
  ref:
    'Built-in reference genomes, fetched on demand as <b>byte ranges</b> from UCSC’s 2bit files — ' +
    'the genome itself never downloads. Type any region in genome-browser coordinates ' +
    '(<b>chrX:57.8M-60.7M</b>, 1-based), a cytogenetic <b>arm</b> (<b>chr13p</b>, resolved from ' +
    'the streamed cytoband track), or a <b>list</b> — comma or ; separated, e.g. ' +
    '<b>chr13p,chr14p,chr15p,chr21p,chr22p</b> lays all five acrocentric short arms on one ' +
    'axis (commas inside numbers are safe). <b>vs</b> splits the axes: ' +
    '<b>chr21p vs chr22p</b> streams the left side as the target (x) and the right side as ' +
    'the query (y) — the direct cross-comparison, no self quadrants; each side may be a full ' +
    'list. Without vs: no query FASTA → the regions plot against themselves; query loaded → ' +
    'it dots against them. All coordinates shown are true genomic positions. Shareable: ' +
    '?ref=t2t&refregion=chr21p+vs+chr22p.',
  matching:
    'These change what is <i>computed</i> — press Recompute after editing. The Display section ' +
    'below applies instantly, without recomputing.',
  k:
    'Exact-match word size — type any value from <b>4 to 26</b> (the slider covers 8+). Longer k ' +
    '→ fewer chance matches and faster, but blinder to diverged sequence; 15 suits most ' +
    'comparisons, 16–21 helps at chromosome scale. k above 16 costs ~1.5× index memory.',
  gap:
    'Merge co-linear matches on one diagonal across up to this many mismatched bases. Type any ' +
    'value ("64", "1kb", …) — presets are suggestions. Larger values give longer, cleaner ' +
    'segments; the bridged mismatch shows up as reduced identity.',
  occ:
    'Skip k-mers occurring more often than this in the target — repeat masking. Any number ' +
    'works; presets are suggestions; <b>off</b> disables occurrence masking entirely (the ' +
    'anchor budget then becomes the only limiter — raise the <b>repeat budget</b> to push it, ' +
    'and expect long computes on satellite-heavy inputs). At genome scale the cutoff also ' +
    'auto-tightens using the index’s own occurrence histogram, so Alu-scale repeat families ' +
    'can’t flood the plot. Where the cutoff bites hardest, the plot says so: regions whose ' +
    'k-mers were mostly over-cap are <b>hatched in the heatmap view</b> and counted in the ' +
    'scoreboard — an empty square there means “not searched”, not “not similar”. Two fine ' +
    'points: the count is <b>forward-strand</b> (reverse matches look up the ' +
    'reverse-complemented query in the same index, so on a self-plot at cap 1 a unique ' +
    'inverted pair still draws — each direction is unique); and on strided indexes the cap is ' +
    'enforced in sampled units, so tiny caps round (a note says when; Refine view is exact).',
  budget:
    'How many match anchors a compute may spend (~60M per strand at <b>auto</b>). The budget is ' +
    'what auto-tightens the repeat cutoff on repeat-rich inputs; <b>2×/4×/8×</b> multiply it, ' +
    'loosening that cutoff — deeper repeat structure for more time and RAM. <b>off</b> removes ' +
    'it entirely: no anchor-volume tightening at all, leaving the segment wall and your ' +
    'patience as the only limits — combine with “skip k-mers: off” for a fully unbounded ' +
    'compute. The <b>segment wall</b> itself defaults to 16M (~1 GB of RAM+GPU, redrawn every ' +
    'frame — a sizing default, not physics) and is raisable to <b>64M</b> from its recovery ' +
    'card or a <b>?wall=32M</b> link: frame rate roughly halves per doubling, and past 64M ' +
    'the GPU buffer outgrows most hardware. <b>Refine view</b> always runs at ≥4×. ' +
    'One caution stands at any budget: satellite families with repeat period &lt; k (HSat2/3) ' +
    'are unenumerable in principle — expect the segment wall there, and trust the hatch.',
  minrun:
    'Drop merged runs shorter than this at compute time ("off", "30", "1kb", any value). At ' +
    'genome scale a small evidence filter applies automatically.',
  sample:
    '<b>auto</b> thins matching on big inputs (every Nth query position, and past 48 Mb the ' +
    'target index strides too) so chromosomes compute in minutes. A <b>number</b> pins the ' +
    'query-side interval only — the target may still stride, and the result note says when. ' +
    '<b>off</b> is <b>true full density</b>, unbounded: every target k-mer indexed, every ' +
    'query position tested, occurrence caps in exact counts. Because the index lives in RAM ' +
    '(~0.5 GB per 50 Mb, ~1.5× that for k &gt; 16), going past 128 Mb of target first ' +
    '<b>asks</b> with the real estimate — one click to proceed or fall back. Pre-approve with ' +
    '<b>off 512M</b> (skips the ask up to 512 Mb; travels in share links). The only hard wall ' +
    'is ~1 Gb, where the browser cannot allocate the index at all. Tip: keep auto for the ' +
    'overview, zoom in, then <b>Refine view</b> for exact windows.',
  annotations:
    'Axis-margin lanes. <b>k-mer multiplicity</b> comes from this plot’s own index — no ' +
    'download, works for any FASTA: ink darkens with log copy number (full ink ≈ 300×+), and ' +
    '<b>blank stretches are unique-k-mer territory</b> — the reliable anchors. Hover reads ' +
    '~N× and the unique fraction; on self-plots the query axis mirrors it. The other tracks ' +
    'stream on demand from UCSC bigBeds as <b>byte ranges</b> for any sequence named like a ' +
    'chromosome of the annotation genome (the selected reference, else T2T) — including ' +
    'reference slices like <b>chr17_ROI10.9</b>, placed by their true coordinates. Fetches ' +
    'follow the view; hover a lane item for its name, span, and strand. CenSat colors are the ' +
    'satellite-family colors from the track itself.',
  drawmode:
    '<b>segments</b> draws every match as a line — the exact view. <b>identity heatmap</b> bins ' +
    'the visible matches into tiles colored by the best anchor identity seen in each (the ' +
    'StainedGlass-style satellite figure): dense repeat fabric becomes a readable identity ' +
    'landscape. Regions above the repeat cutoff wear a <b>diagonal hatch</b> — matches there ' +
    'were never enumerated, so blank ≠ dissimilar. <b>ANI heatmap</b> escapes the cap ' +
    'entirely: every tile pair is compared by the <b>multiset containment</b> of its exact ' +
    'k-mer counts, mapped to ANI = c^(1/k) (the Mash/ModDotPlot estimator, made ' +
    'count-weighted) — no matches enumerated, no occurrence cap, no hatch, satellite cores ' +
    'included; it recomputes for the visible window when you rest, on self-plots and ' +
    'cross-plots alike (alignment-free inputs). Hover reads a tile; the aligner overlay ' +
    'still draws on top. PNG captures the heatmaps (SVG stays segment-only).',
  anitiles:
    'Grid resolution of the ANI heatmap. <b>auto</b> sizes to your display and a work budget ' +
    '(satellite-dense windows may coarsen — the legend reports the tiles and their bp size). ' +
    'An explicit count (to <b>1024</b>) is honored outright: finer than the screen for ' +
    'publication export, at whatever compute time it takes. Each tile spans window÷N bases, ' +
    'so <b>zooming in refines resolution for free</b> — the grid recomputes per view. Rides ' +
    'share links (?anitiles=1024).',
  detail:
    'The exploration dial, always at hand. <b>Min segment length</b> filters what is <i>drawn</i> ' +
    '(never what was computed): low reveals the repeat fabric, high shows clean structure — drag ' +
    'the slider, type an exact value, or press <kbd>[</kbd>/<kbd>]</kbd> from the plot. Dense ' +
    'results pick a sane starting value automatically. <b>Refine view</b> lives below, with ' +
    '<b>auto</b> to refine as you go.',
  refine:
    'Recomputes the <i>visible window</i> at full density with a raised repeat budget, merging ' +
    'it into the plot in place — axes, zoom, and the aligner overlay stay put. Press <kbd>F</kbd> ' +
    'or the ✦ button by the zoom controls; it works at <b>any</b> zoom, including full fit — ' +
    'refining a whole centromere window digs deeper into its repeat families. With <b>auto</b> ' +
    'checked, resting a moment at a zoomed view refines it by itself. Needs the FASTA inputs ' +
    'still loaded.',
  share:
    'Copies a link that reproduces this exact view: the data (when it came from a reference, ' +
    'the demo, or URLs), the viewport, display settings, and any non-default matching options. ' +
    'Locally loaded files cannot travel in a link — everything else can. Paste it anywhere; ' +
    'opening it replays the compute and lands on the same pixels.',
  minident:
    'Hide segments below this <b>anchor identity</b> — dotdot’s metric: the fraction of a ' +
    'merged run covered by exact k-mer anchors, after crediting sampling holes (bridged ' +
    'mismatch/indel bases count against it). It is deliberately not alignment identity ' +
    '(StainedGlass’s 100·M/(M+X+I+D)) nor k-mer ANI (ModDotPlot’s c^(1/k)) — it comes from ' +
    'exact occurrence counts, no aligner. For PAF overlays the value is the aligner’s own ' +
    'nmatch/alnlen. Instant — nothing recomputes.',
  strands:
    'Forward matches are blue; reverse-complement matches are orange — inversions appear as ' +
    'orange anti-diagonals. Toggle with keys <kbd>1</kbd> and <kbd>2</kbd>.',
  colorby:
    '“identity” shades each segment by anchor identity (legend ramps); “strand only” uses flat ' +
    'blue/orange. “<b>k-mer multiplicity</b>” recolors every segment by the copy number of the ' +
    'target sequence it sits on — the same neutral→ink scale as the axis lane (1× unique pale, ' +
    '≥300× full ink), from this plot’s own index. Repeat families light up as families; unique ' +
    'anchors recede. Long segments shade along their length as they cross repeat boundaries. ' +
    'Alignment-free plots only; strand toggles and filters still apply.',
  minpx:
    'Stretch tiny matches to a minimum on-screen size so small features remain visible when ' +
    'zoomed way out.',
  aspect: 'Lock both axes to the same bp-per-pixel scale, so perfect matches run at exactly 45°.',
  region:
    'Jump to a target region: <b>chr17:18.3M-19.4M</b>, a bare sequence name, or ' +
    '<b>100,000-250,000</b>. The query axis frames whatever maps there; when a region maps to ' +
    'several places (other haplotype, duplications), pressing Go again cycles through them.',
  overlay:
    'Drop an aligner’s PAF on an existing plot and its calls draw as ink lines with diamond ' +
    'breakpoint markers over the alignment-free layer — the aligner’s story against the raw ' +
    'sequence structure. Display filters never touch the overlay.',
  belongs:
    'Count-weighted <b>k-mer containment</b> between every pair of loaded sequences: each cell ' +
    'is the share of the <i>row’s</i> k-mers — copy counts included, strands canonical, so a ' +
    'reverse-complemented contig still belongs — found anywhere in the <i>column</i>. Rows ' +
    'normalize by themselves, so a short fragment reads honestly against a whole chromosome. ' +
    'Hover a cell for both directions and the k-mer ANI estimate; click a plottable cell to ' +
    'zoom to that pair. <b>where?</b> decomposes one record over windows of the others — ' +
    'greedy: each round the most-explanatory window <b>claims</b> its k-mers, debiting both ' +
    'the record’s copies and the window’s own, so shares are disjoint; between near-identical ' +
    'homes the first winner takes the shared mass (ties break to load order). That is ' +
    '<b>parsimony, not affinity</b> — for ambiguous placement read the matrix row, and watch ' +
    'the <i>contested</i> share and the position strip. The <b>cells</b> toggle re-lenses the ' +
    'matrix: <i>exclusive to pair</i> (content no third home could explain) and <i>unique ' +
    'content</i> (repeat families removed) — hover any cell for every metric, including the ' +
    'copy ratio of shared content. <b>Shared content is not locus homology</b>: repeat ' +
    'families make unrelated loci “belong”. Full definitions, the claim contract, and a ' +
    'reading guide: <b>Methods…</b> at the bottom of the card. The <b>Report</b> button in ' +
    'Export composes the plot, these grids, the gather, and the distribution charts into ' +
    'one PNG.',
};

/**
 * The Belongs deep-dive: full definitions, the claim contract, and the
 * reading guide — the card's Methods… view. The "?" popover above is the
 * quick layer; this is the complete one. Plain-text math on purpose.
 */
export const BELONGS_METHODS =
  `<h4>The gist</h4>
<p class="stats-sum">Chop every sequence into all its overlapping k-letter words and keep
them in a bag — copies included, and either reading direction counts as the same word.
Everything on this card is arithmetic on those bags: nothing is ever aligned, and word
order is ignored on purpose.</p>
<p class="stats-sum"><b>The matrix</b> asks “how much of this bag is in that one?” Each
cell: take the row’s words — a word carried five times counts five — and see how many the
column’s bag can match, then divide by the row’s total. A short contig is judged against
its own bag, so it reads fairly against a whole chromosome.</p>
<p class="stats-sum"><b>where?</b> asks “which pieces of everything else could this bag
have come from?” The other sequences are cut into windows and the words are dealt out like
tracing borrowed phrases to their sources: the window able to account for the most
still-unaccounted words claims them — one copy each, never more copies than the window
itself holds — and the game repeats until nothing worth claiming remains. Every word is
attributed exactly once, which is why the shares add up.</p>
<p class="stats-sum"><b>The catch:</b> when two sources hold the same words, whoever is
picked first takes them — the decomposition is one <i>sufficient</i> explanation, not the
only one. That is what the extra instruments are for: <b>contested</b> counts claimed words
that also sit in another source’s bag (high = the pick was a coin flip; check the matrix
row), and the <b>strip</b> paints where along your record each source’s claims land — a
glued-together assembly shows as blocks from different sources.</p>

<h4>The statistic</h4>
<p class="stats-sum">Every sequence is a <b>multiset</b> of canonical k-mers: each window of k
bases contributes min(kmer, revcomp) — one species per window, so orientation never matters
(an inverted contig belongs exactly as much). For records A and B with per-species copy
counts c<sub>A</sub>(s) and c<sub>B</sub>(s):</p>
<p class="stats-sum">shared(A,B) = Σ<sub>s</sub> min(c<sub>A</sub>(s), c<sub>B</sub>(s)) ·
containment C(A ⊂ B) = shared / Σ<sub>s</sub> c<sub>A</sub>(s) ·
k-mer ANI ≈ (shared / min(mass<sub>A</sub>, mass<sub>B</sub>))<sup>1/k</sup></p>
<p class="stats-sum">Counting <b>copies</b> (multiset) rather than distinct species (set) is
what keeps tandem arrays honest: set containment saturates the moment one copy matches;
count-weighted containment still notices when one record carries 50× more of the family.
Containment — not Jaccard — is the right normalization for unequal lengths: a fragment is
judged by <i>its own</i> mass, wherever it lands.</p>
<p class="stats-sum">The <b>cells</b> toggle re-lenses the same scan. <b>exclusive to
pair</b> keeps only species held by exactly those two records — content no third home could
explain, the placement-deciding complement of communal repeat mass (the matrix-level twin
of the gather's contested share). <b>unique content</b> keeps only the row's single-copy
species — containment with the row's own repeat families removed, so satellite commons
stop inflating "belongs"; a record with no single-copy k-mers shows a dash, honestly. The
hover adds a fourth instrument, the <b>copy ratio</b> of the shared vocabulary (Σ row
copies ÷ Σ column copies over common species): a collapsed-repeat detector, because
containment can look perfect while one side carries fifty-fold fewer copies of what it
shares. All four come from the one scan — no extra compute.</p>

<h4>Sampling</h4>
<p class="stats-sum">Past ~24M k-mers the scan samples k-mer <b>value</b> space (FracMinHash):
a species is kept iff hash(s) &lt; 2³²/scaled, so it is in or out <i>globally</i> — every
record sees the same sample and ratios stay unbiased. Sampling <b>positions</b> instead (the
plot index’s stride) would require a k-mer to survive sampling independently on every side,
collapsing min() for unique content. scaled is disclosed on the card; scaled = 1 is exact.
The hash is deterministic — reruns agree.</p>

<h4>The gather (“where?”)</h4>
<p class="stats-sum">Every other record is cut into uniform windows (the <b>window</b> dial;
auto = combined span of the others ÷ 192, floored at 1 kb). Two budgets exist per species:
copies still unexplained in the record, and unspent copies in each window. Each round the
window that could explain the most still-unclaimed mass wins and <b>claims</b>: per species,
take = min(record remaining, window unspent), debited from <i>both</i> budgets. Hence the
guarantees — no record copy explained twice, no window explaining more copies than it holds,
shares disjoint and summing to the explained total. Rounds stop when the best window would
add &lt; max(1 k-mer, 0.1% of the record’s mass). Adjacent claimed windows of one record
merge into ranges.</p>
<p class="stats-sum"><b>The one thing to internalize:</b> between near-identical homes, the
first winner absorbs the shared mass and exact ties break to the lowest window id — earlier
record, in load order. The decomposition is a <i>parsimonious cover</i> (“one sufficient
explanation”), not an affinity distribution. Ambiguity is measured by the two diagnostics
below and by the matrix row, whose cells are computed independently with no claiming at
all.</p>

<h4>Reading the three cases</h4>
<div class="belongs-wrap"><table class="belongs-table">
<thead><tr><th>signature</th><th>matrix row</th><th>position strip</th><th>contested</th></tr></thead>
<tbody>
<tr><th>clearly one source</th><td>one high cell</td><td>one color end to end</td><td>low</td></tr>
<tr><th>highly homologous (ambiguous)</th><td>two+ high cells</td><td>one color, or salt-and-pepper between the tied homes</td><td><b>high</b></td></tr>
<tr><th>misassembled / chimeric</th><td>mid-level cells</td><td><b>contiguous blocks</b>, different sources by position</td><td>any</td></tr>
</tbody></table></div>
<p class="stats-sum">The <b>position strip</b> cuts the record into slices and paints each by
the record whose windows claimed it (claims are spread over the slices a species occupies,
weighted by its copies there). Misassembly is <i>spatial</i>: long contiguous blocks from
different sources. Homology is <i>statistical</i>: the same stretch claimable by several
sources — the strip may salt-and-pepper between tied homes (a tie-break artifact, window by
window), and the real signal is the contested share, defined per component as the claimed
mass whose species also occur in ≥ 2 candidate records. Unexplained slices stay dark: content found in
nothing loaded (novel sequence, or below the sampling floor).</p>

<h4>Limits</h4>
<p class="stats-sum">Shared content is <b>not</b> locus homology — repeat families carry
“belongs” across unrelated loci (the acrocentric arms all belong to each other). The
statistic is blind to order and orientation by construction: a shuffled or inverted record
has identical containment. Contested is record-level: two near-identical windows <i>inside
one record</i> are not counted. At scaled &gt; 1 all shares carry sampling noise at the
margins. k is the plot’s k: smaller k drifts toward compositional similarity, larger k
toward strict identity.</p>

<h4>Lineage</h4>
<p class="stats-sum">Containment index and screening: Mash Screen (Ondov 2019). Value
sampling and greedy decomposition: FracMinHash / sourmash gather (Irber 2022) — here made
count-weighted, window-resolved, and capacity-constrained on both sides. Tile ANI by
containment: the ModDotPlot lineage, shared with this app’s ANI heatmap. The matrix is exact
(or FracMinHash-estimated) multiset containment — deliberately not alignment identity and
not anchor identity; the app names which is which, everywhere.</p>`;

/** Accessible names for the "?" buttons — a rotor list of twenty identical
 * "question mark" entries helps nobody. @type {Record<string, string>} */
const HELP_LABEL = {
  controls: 'mouse and keyboard controls',
  data: 'inputs',
  ref: 'reference regions',
  matching: 'matching options',
  k: 'k-mer size',
  gap: 'gap bridging',
  occ: 'the occurrence cap',
  budget: 'the repeat budget',
  minrun: 'min match length',
  sample: 'sampling',
  annotations: 'annotation tracks',
  drawmode: 'draw modes',
  anitiles: 'ANI tile resolution',
  detail: 'the detail controls',
  refine: 'refine view',
  share: 'share links',
  minident: 'the anchor-identity filter',
  strands: 'strand colors',
  colorby: 'color modes',
  minpx: 'small-match emphasis',
  aspect: 'the 1:1 aspect lock',
  region: 'region jump',
  overlay: 'the aligner overlay',
  belongs: 'the belongs matrix',
};

const helpPop = document.createElement('div');
helpPop.id = 'help-pop';
helpPop.hidden = true;
document.body.append(helpPop);

/** @type {HTMLElement | null} */
let helpAnchor = null;

export function closeHelp() {
  helpPop.hidden = true;
  if (helpAnchor) helpAnchor.setAttribute('aria-expanded', 'false');
  helpAnchor = null;
}

// The popover is positioned once, from the button's rect — a sidebar scroll
// or window resize would leave it floating over unrelated controls.
window.addEventListener('scroll', () => {
  if (helpAnchor) closeHelp();
}, true);
window.addEventListener('resize', () => {
  if (helpAnchor) closeHelp();
});

document.addEventListener(
  'click',
  (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const btn = t.closest('.help');
    if (btn instanceof HTMLElement) {
      // Keep the click from reaching the label/control underneath.
      e.preventDefault();
      e.stopPropagation();
      if (helpAnchor === btn) {
        closeHelp();
        return;
      }
      const html = HELP[/** @type {keyof typeof HELP} */ (btn.dataset.help ?? '')];
      if (!html) return;
      helpPop.innerHTML = html;
      helpPop.hidden = false;
      helpAnchor = btn;
      btn.setAttribute('aria-expanded', 'true');
      const r = btn.getBoundingClientRect();
      helpPop.style.left = '0px';
      helpPop.style.top = '0px';
      const pw = helpPop.offsetWidth;
      const ph = helpPop.offsetHeight;
      let x = r.left;
      let y = r.bottom + 6;
      if (x + pw > innerWidth - 8) x = innerWidth - pw - 8;
      if (y + ph > innerHeight - 8) y = r.top - ph - 6;
      helpPop.style.left = `${Math.max(4, x)}px`;
      helpPop.style.top = `${Math.max(4, y)}px`;
    } else if (!helpPop.hidden && !t.closest('#help-pop')) {
      closeHelp();
    }
  },
  true,
);

/**
 * Stamp accessible names + expanded state onto every "?" button. Called
 * once from main after the static DOM exists.
 */
export function initHelp() {
  for (const b of document.querySelectorAll('.help')) {
    const key = b instanceof HTMLElement ? b.dataset.help : undefined;
    b.setAttribute('aria-label', `about ${(key && HELP_LABEL[key]) || key || 'this control'}`);
    b.setAttribute('aria-expanded', 'false');
  }
}
