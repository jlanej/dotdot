// @ts-check
/**
 * The settle bus: one current view signature + settle timestamp, and gates
 * that each consumer (annotations, heatmap, containment, auto-refine) holds
 * to ask "has the view rested on something I haven't handled yet?".
 *
 * This replaces four hand-rolled sig-string caches whose scattered reset
 * sites produced a whole bug class (ANI dead after Recompute, stale theme
 * pixels, double rebins): invalidation is now a named method on the gate
 * that owns it, and the '' guard — no view is not a settled view — lives in
 * exactly one place. Pure and DOM-free, so the semantics are unit-tested.
 */

export class ViewSettle {
  constructor() {
    /** Current rounded-viewport signature ('' = no view yet). */
    this.sig = '';
    /** When the signature last changed (caller's clock). */
    this.settledAt = 0;
    /** @type {SigGate[]} */
    this.gates = [];
  }

  /**
   * Feed the current signature each frame. Returns true when it CHANGED —
   * the view is moving, and consumers should wait for rest.
   * @param {string} sig @param {number} now
   */
  update(sig, now) {
    if (sig !== this.sig) {
      this.sig = sig;
      this.settledAt = now;
      return true;
    }
    return false;
  }

  /**
   * Forget the view entirely (Clear): nothing fires until a new sig lands,
   * and every gate un-handles — the next session's identical viewport must
   * count as new work (a gate left stamped across a reset was exactly the
   * stale-cache class this module exists to kill).
   */
  reset() {
    this.sig = '';
    this.settledAt = 0;
    for (const g of this.gates) g.invalidate();
  }

  /** A new consumer gate over this bus. */
  gate() {
    const g = new SigGate(this);
    this.gates.push(g);
    return g;
  }
}

export class SigGate {
  /** @param {ViewSettle} settle */
  constructor(settle) {
    this.settle = settle;
    /** The signature this gate last handled. */
    this.done = '';
  }

  /**
   * True when the view has rested at least `ms` on a signature this gate
   * has not handled. Never fires on '' — no view is not a settled view.
   * @param {number} now @param {number} ms
   */
  due(now, ms) {
    const s = this.settle;
    return s.sig !== '' && s.sig !== this.done && now - s.settledAt >= ms;
  }

  /** Mark the current signature handled (direct rebuilds count too). */
  stamp() {
    this.done = this.settle.sig;
  }

  /** Un-handle: the next settle fires again, even on the same signature. */
  invalidate() {
    this.done = '';
  }
}
