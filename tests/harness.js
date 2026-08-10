// @ts-check
/**
 * Minimal dual-runtime test harness. Under Deno (`deno test tests/`), tests
 * register with Deno.test; in the browser (tests/index.html), they queue and
 * the runner page executes them. No dependencies either way.
 */

/** @type {{name: string, fn: () => void | Promise<void>}[]} */
const queue = [];

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
export function test(name, fn) {
  const deno = /** @type {{test?: (name: string, fn: () => void | Promise<void>) => void}} */ (
    /** @type {any} */ (globalThis).Deno
  );
  if (deno && typeof deno.test === 'function') deno.test(name, fn);
  else queue.push({ name, fn });
}

/**
 * Browser runner: execute everything queued.
 * @param {(name: string, err: Error | null) => void} report
 */
export async function runAll(report) {
  for (const t of queue) {
    try {
      await t.fn();
      report(t.name, null);
    } catch (err) {
      report(t.name, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return queue.length;
}

/**
 * @param {unknown} cond @param {string} [msg]
 */
export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

/**
 * @param {unknown} a @param {unknown} b @param {string} [msg]
 */
export function assertEq(a, b, msg) {
  if (!Object.is(a, b)) {
    throw new Error(`${msg ?? 'not equal'} — got ${String(a)}, want ${String(b)}`);
  }
}

/**
 * @param {number} a @param {number} b @param {number} [eps] @param {string} [msg]
 */
export function assertClose(a, b, eps = 1e-9, msg) {
  if (!(Math.abs(a - b) <= eps)) {
    throw new Error(`${msg ?? 'not close'} — got ${a}, want ${b} ± ${eps}`);
  }
}

/**
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b @param {string} [msg]
 */
export function assertArrayEq(a, b, msg) {
  if (a.length !== b.length) {
    throw new Error(`${msg ?? 'array mismatch'} — lengths ${a.length} vs ${b.length}`);
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(`${msg ?? 'array mismatch'} — index ${i}: ${a[i]} vs ${b[i]}`);
    }
  }
}
