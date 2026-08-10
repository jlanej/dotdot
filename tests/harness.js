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
 * Deterministic 32-bit PRNG for reproducible test fixtures.
 * @param {number} seed
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
