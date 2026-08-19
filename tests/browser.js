// @ts-check
/** Browser test runner: imports every suite, executes the queue, reports. */
import './annotations.test.js';
import './assemble.test.js';
import './bigbed.test.js';
import './dna.test.js';
import './fasta.test.js';
import './paf.test.js';
import './kmer.test.js';
import './transform.test.js';
import './grid.test.js';
import './heatmap.test.js';
import './catalog.test.js';
import './charts.test.js';
import './colormap.test.js';
import './compress.test.js';
import './compute.test.js';
import './format.test.js';
import './refs.test.js';
import './region.test.js';
import './settle.test.js';
import './share.test.js';
import './twobit.test.js';
import { runAll } from './harness.js';

const results = /** @type {HTMLElement} */ (document.getElementById('results'));
const summary = /** @type {HTMLElement} */ (document.getElementById('summary'));

let pass = 0;
let fail = 0;

const total = await runAll((name, err) => {
  const div = document.createElement('div');
  if (err) {
    fail++;
    div.className = 'fail';
    div.textContent = `✗ ${name}`;
    const pre = document.createElement('pre');
    pre.textContent = String(err.stack || err.message);
    results.append(div, pre);
    console.error(`FAIL: ${name}`, err);
  } else {
    pass++;
    div.className = 'pass';
    div.textContent = `✓ ${name}`;
    results.append(div);
  }
});

summary.textContent = fail === 0 ? `ALL ${total} TESTS PASSED` : `${fail} of ${total} TESTS FAILED`;
summary.className = fail === 0 ? 'pass' : 'fail';
console.log(`DOTDOT-TESTS: ${pass} passed, ${fail} failed, ${total} total`);
