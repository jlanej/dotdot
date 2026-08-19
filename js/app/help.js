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
    'Hover a cell for both directions and the k-mer ANI estimate (containment^(1/k), the ANI ' +
    'heatmap’s statistic); click a plottable cell to zoom to that pair. <b>where?</b> ' +
    'decomposes one record over windows of the others, greedily, each k-mer copy claimed once ' +
    '(sourmash-gather style): “62% of this contig is explained by chr17:18.2–18.6M”. Large ' +
    'inputs are sampled by k-mer <i>value</i> (FracMinHash, disclosed in the card) — never by ' +
    'position, which would bias cross-record ratios. <b>Shared content is not locus ' +
    'homology</b>: repeat families make unrelated loci “belong”.',
};

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
