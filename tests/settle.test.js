// @ts-check
import { test, assert, assertEq } from './harness.js';
import { ViewSettle } from '../js/app/settle.js';

test('settle: a changed signature restarts the rest timer', () => {
  const s = new ViewSettle();
  assert(s.update('a', 100), 'first sig counts as a change');
  assert(!s.update('a', 150), 'same sig is not a change');
  assertEq(s.settledAt, 100);
  assert(s.update('b', 200), 'new sig is a change');
  assertEq(s.settledAt, 200);
});

test('settle: a gate fires once per settled signature, after its rest time', () => {
  const s = new ViewSettle();
  const g = s.gate();
  assert(!g.due(1000, 400), 'no view yet — never due');
  s.update('a', 1000);
  assert(!g.due(1200, 400), 'still resting');
  assert(g.due(1400, 400), 'rested long enough');
  g.stamp();
  assert(!g.due(2000, 400), 'handled — quiet until something changes');
  s.update('b', 2000);
  assert(g.due(2400, 400), 'new signature re-arms the gate');
});

test('settle: invalidate re-fires on the SAME settled signature', () => {
  // The bug class this exists for: Recompute refits to identical bounds —
  // the same signature — and the old sig-string caches never refired.
  const s = new ViewSettle();
  const g = s.gate();
  s.update('a', 0);
  g.stamp();
  assert(!g.due(500, 100), 'handled');
  g.invalidate();
  assert(g.due(500, 100), 'invalidate re-arms without a view change');
});

test('settle: gates are independent; reset silences everything', () => {
  const s = new ViewSettle();
  const g1 = s.gate();
  const g2 = s.gate();
  s.update('a', 0);
  g1.stamp();
  assert(!g1.due(999, 100) && g2.due(999, 100), 'stamping one gate leaves the other due');
  s.reset();
  assert(!g1.due(9999, 100) && !g2.due(9999, 100), 'no view is not a settled view');
  s.update('a', 10_000);
  assert(g1.due(10_200, 100), 'the same sig after reset counts as new work');
});
