#!/usr/bin/env node
import { loadConfig } from '../src/core/config.mjs';
import { WinHost } from '../src/winhost/client.mjs';
import { Perception } from '../src/perception/perception.mjs';

/**
 * Measure real perception latency on this machine. Useful for choosing budgets
 * and for detecting a slow/stuck UI Automation provider.
 *   node scripts/benchmark_perception.mjs [--iterations 5] [--json]
 */
const argv = process.argv.slice(2);
const iterArg = argv.indexOf('--iterations');
const iterations = iterArg >= 0 ? Number(argv[iterArg + 1]) : 5;
const json = argv.includes('--json');

const config = loadConfig(process.cwd());
const host = new WinHost({ root: config.root, screenshotDir: config.screenshots.dir });
const perception = new Perception({ host, config });
await host.start();

const results = { screenshot: [], ui_tree: [], ocr: [], active_window: [], observe: [], screen_info: [] };

for (let i = 0; i < iterations; i++) {
  results.screen_info.push(await time(() => host.call('screen_info')));
  results.active_window.push(await time(() => host.call('active_window')));
  results.screenshot.push(await time(() => perception.screenshot({ target: 'active_window' })));
  results.ui_tree.push(await time(() => perception.uiTree({})));
  results.ocr.push(await time(() => perception.readVisibleText({})));
  results.observe.push(await time(() => perception.observe({ includeOcr: false })));
}

await host.dispose();

const summary = Object.fromEntries(Object.entries(results).map(([k, values]) => [k, stats(values)]));
if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Perception benchmark (${iterations} iterations, real calls)\n`);
  console.log('method          min     p50     p95     max');
  for (const [k, s] of Object.entries(summary)) {
    console.log(`${k.padEnd(15)} ${String(s.min).padStart(5)}ms ${String(s.p50).padStart(6)}ms ${String(s.p95).padStart(6)}ms ${String(s.max).padStart(6)}ms`);
  }
  console.log('\nobserve = active window + screenshot + UIA tree (no OCR).');
}

async function time(fn) {
  const t = performance.now();
  await fn();
  return Math.round(performance.now() - t);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1],
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length), n: sorted.length,
  };
}
