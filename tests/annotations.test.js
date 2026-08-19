// @ts-check
import { test, assert, assertEq } from './harness.js';
import { LaneBuilder, resolveChrom, multLane } from '../js/app/annotations.js';

/** @typedef {import('../js/io/bigbed.js').BedItem} BedItem */

const CHROMS = new Map([
  ['chr17', { id: 0, size: 83_000_000 }],
  ['chr8', { id: 1, size: 145_000_000 }],
]);

/**
 * In-memory track source: fixed items per chromosome, and a log of every
 * query so the tile cache's fetch behavior is assertable.
 * @param {Record<string, BedItem[]>} itemsByChrom
 */
function fakeSource(itemsByChrom) {
  /** @type {{chrom: string, s: number, e: number}[]} */
  const calls = [];
  return {
    calls,
    src: {
      chroms: async () => CHROMS,
      /** @param {string} chrom @param {number} s @param {number} e */
      query: async (chrom, s, e) => {
        calls.push({ chrom, s, e });
        return (itemsByChrom[chrom] ?? []).filter((it) => it.start < e && it.end > s);
      },
    },
  };
}

/** @type {import('../js/refs.js').RefTrack} */
const TRACK = { id: 'fake', label: 'fake track', url: 'mem://fake.bb', on: true, colored: true };

test('annotations: resolveChrom matches exact, arm-suffix, and slice-prefix names', () => {
  assertEq(resolveChrom('chr17', CHROMS), 'chr17');
  assertEq(resolveChrom('chr17p', CHROMS), 'chr17'); // arm record from a p-arm stream
  assertEq(resolveChrom('chr17_ROI10.9', CHROMS), 'chr17'); // demo slice naming
  assertEq(resolveChrom('tig00042', CHROMS), null);
  // 'tig00042p' must NOT strip to 'tig00042' unless that chromosome exists.
  assertEq(resolveChrom('tig00042p', CHROMS), null);
});

test('annotations: tile cache fetches each 1 Mb tile once and dedupes spanners', async () => {
  const { calls, src } = fakeSource({
    chr17: [
      { start: 500_000, end: 1_500_000, name: 'spanner', strand: '+', rgb: '10,20,30' },
      { start: 100_000, end: 200_000, name: 'early', strand: '', rgb: null },
    ],
  });
  const lb = new LaneBuilder(() => src);
  const first = await lb.tileQuery(TRACK, 'chr17', 0, 2_000_000);
  assertEq(first.length, 2); // the spanner appears once despite touching 2 tiles
  assertEq(calls.length, 2); // tiles [0,1M) and [1M,2M)
  const again = await lb.tileQuery(TRACK, 'chr17', 400_000, 1_600_000);
  assertEq(again.length, 1); // only the spanner overlaps this window
  assertEq(calls.length, 2); // fully served from cache — no new fetches
});

test('annotations: tile cache eviction is bounded', async () => {
  const { calls, src } = fakeSource({ chr17: [] });
  const lb = new LaneBuilder(() => src, 1_000_000, 2); // tiny cache
  await lb.tileQuery(TRACK, 'chr17', 0, 3_000_000); // tiles 0,1,2 — evicts tile 0
  assertEq(calls.length, 3);
  await lb.tileQuery(TRACK, 'chr17', 0, 1_000_000); // tile 0 must refetch
  assertEq(calls.length, 4);
});

test('annotations: @offset slices query genomic coordinates and map items back', async () => {
  // A 400 kb slice of chr17 starting at genomic 10,600,000 (@offset), shown
  // as band [0, 400k) in world space.
  const item = { start: 10_650_000, end: 10_700_000, name: 'roi', strand: '+', rgb: '1,2,3' };
  const { calls, src } = fakeSource({ chr17: [item] });
  const lb = new LaneBuilder(() => src);
  /** @type {import('../js/core/types.js').AxisCatalog} */
  const cat = {
    names: ['chr17_ROI10.9'],
    starts: new Float64Array([0, 400_000]),
    total: 400_000,
    offsets: Float64Array.from([10_600_000]),
  };
  const lanes = await lb.buildAxisLanes(cat, 0, 400_000, [TRACK]);
  assert(lanes !== null, 'the slice name resolves to chr17');
  const items = /** @type {NonNullable<typeof lanes>} */ (lanes)[0].items;
  assertEq(items.length, 1);
  assertEq(items[0].w0, 50_000); // 10,650,000 − offset
  assertEq(items[0].w1, 100_000);
  // And the FETCH went out in genomic coordinates, not band-local ones.
  assert(calls.every((c) => c.s >= 10_000_000), `queried genomic coords: ${JSON.stringify(calls)}`);
});

test('annotations: items clip to their band and unresolvable axes return null', async () => {
  const item = { start: 0, end: 90_000_000, name: 'huge', strand: '', rgb: null };
  const { src } = fakeSource({ chr8: [item] });
  const lb = new LaneBuilder(() => src);
  /** @type {import('../js/core/types.js').AxisCatalog} */
  const cat = {
    names: ['chr8', 'tigZ'],
    starts: new Float64Array([0, 1_000_000, 2_000_000]),
    total: 2_000_000,
  };
  const lanes = await lb.buildAxisLanes(cat, 0, 2_000_000, [TRACK]);
  const items = /** @type {NonNullable<typeof lanes>} */ (lanes)[0].items;
  assertEq(items.length, 1);
  assertEq(items[0].w1, 1_000_000); // clipped at the band edge — never into tigZ
  const none = await lb.buildAxisLanes(
    { names: ['tigZ'], starts: new Float64Array([0, 100]), total: 100 },
    0,
    100,
    [TRACK],
  );
  assertEq(none, null);
});

test('annotations: the multiplicity lane buckets, thresholds, and labels', () => {
  // Four 512 bp tiles: unique (1×, below the ink threshold), deep (100×).
  const prof = {
    tileBp: 512,
    mult: Float32Array.from([1, 1, 100, 100]),
    uniqFrac: Float32Array.from([1, 1, 0.02, 0.02]),
  };
  const lane = multLane(prof, 1, 0, 2048, 2048, (t) => `ink(${t.toFixed(2)})`);
  assert(lane !== null);
  const items = /** @type {NonNullable<typeof lane>} */ (lane).items;
  // The unique tiles fall under the 0.03 ink threshold — blank stays blank.
  assertEq(items.length, 2);
  assert(items[0].name.startsWith('k-mers 100×'), items[0].name);
  assert(items[0].name.includes('2% unique'), items[0].name);
  // stride > 1 marks counts as estimates
  const approx = multLane(prof, 2, 0, 2048, 2048, () => 'x');
  const aItems = /** @type {NonNullable<typeof approx>} */ (approx).items;
  assert(aItems[0].name.startsWith('k-mers ~'), aItems[0].name);
});
