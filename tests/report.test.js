// @ts-check
import { test, assert, assertEq } from './harness.js';
import { reportLayout, RL } from '../js/export/report.js';

test('report layout: panels stack in order without overlap', () => {
  const lay = reportLayout({
    plotW: 1200,
    plotH: 800,
    subLines: 2,
    nR: 5,
    gridCount: 3,
    gatherRows: 6,
    chartCount: 3,
    footerLines: 3,
  });
  assert(lay.W >= 1200 + 2 * RL.pad, 'width fits the plot');
  assert(lay.plot.y >= lay.header.y + lay.header.h, 'plot below header');
  assertEq(lay.grids.length, 3);
  for (const g of lay.grids) assert(g.y >= lay.plot.y + lay.plot.h, 'grids below plot');
  assert(lay.gather && lay.gather.y >= lay.grids[0].y + lay.grids[0].h, 'gather below grids');
  const g = /** @type {NonNullable<typeof lay.gather>} */ (lay.gather);
  for (const c of lay.charts) assert(c.y >= g.y + g.h, 'charts below gather');
  assert(lay.footer.y >= lay.charts[0].y + lay.charts[0].h, 'footer below charts');
  assert(lay.H >= lay.footer.y + lay.footer.h, 'canvas covers footer');
});

test('report layout: grids and charts wrap at the report width', () => {
  const lay = reportLayout({
    plotW: 700, // floored to 720 content width
    plotH: 500,
    subLines: 1,
    nR: 8, // grid width 100 + 8*56 = 548 — two do not fit side by side
    gridCount: 3,
    gatherRows: 0,
    chartCount: 3, // 460 wide — the 720 content width fits exactly one per row
    footerLines: 2,
  });
  assertEq(lay.grids[0].x, RL.pad);
  assert(lay.grids[1].y > lay.grids[0].y, 'second grid wrapped to a new row');
  assertEq(lay.grids[1].x, RL.pad);
  assert(lay.charts[1].y > lay.charts[0].y, 'second chart wrapped');
  assertEq(lay.gather, null, 'no gather panel requested');
});

test('report layout: optional panels collapse cleanly', () => {
  const lay = reportLayout({
    plotW: 1000,
    plotH: 600,
    subLines: 1,
    nR: 0,
    gridCount: 0,
    gatherRows: 0,
    chartCount: 0,
    footerLines: 1,
  });
  assertEq(lay.grids.length, 0);
  assertEq(lay.gather, null);
  assertEq(lay.charts.length, 0);
  assert(lay.footer.y - (lay.plot.y + lay.plot.h) < 3 * RL.sectionGap, 'no phantom gaps');
});
