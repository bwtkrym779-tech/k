import { WinHost } from '../src/winhost/client.mjs';

const host = new WinHost({ root: process.cwd(), timeoutMs: 30000 });
const t0 = Date.now();
await host.start();
console.log('ready in', Date.now() - t0, 'ms', await host.call('ping'));

const info = await host.call('screen_info');
console.log('screen', JSON.stringify(info.virtual_screen), 'monitors', info.monitors.length, 'ocr', info.ocr_languages);

let t = Date.now();
const shot = await host.call('screenshot', { target: 'full' });
console.log(`shot full ${Date.now() - t}ms`, shot.width + 'x' + shot.height, shot.sha256.slice(0, 12), shot.ahash, shot.ref);

t = Date.now();
const wins = await host.call('list_windows', {});
console.log(`windows ${Date.now() - t}ms`, wins.count);
for (const w of wins.windows.slice(0, 5)) console.log(' -', w.process, '|', w.title.slice(0, 60), '|', w.bounds.width + 'x' + w.bounds.height);

t = Date.now();
const win = await host.call('active_window');
console.log(`active_window ${Date.now() - t}ms`, win.process, win.title.slice(0, 60));

t = Date.now();
const tree = await host.call('ui_tree', { depth: 3, max_nodes: 120 });
console.log(`ui_tree ${Date.now() - t}ms nodes=${tree.node_count} truncated=${tree.truncated} snapshot=${tree.snapshot}`);
for (const n of tree.nodes.slice(0, 10)) console.log('  ', n.id, n.role, JSON.stringify(n.name).slice(0, 40), n.patterns.join(','));

if (tree.nodes.length > 1) {
  const target = tree.nodes.find((n) => n.name) ?? tree.nodes[1];
  const insp = await host.call('inspect_element', { element_id: target.id });
  console.log('inspect', insp.id, insp.role, JSON.stringify(insp.name).slice(0, 40), insp.patterns.join(','));
}

t = Date.now();
const ocr = await host.call('ocr', {});
console.log(`ocr ${Date.now() - t}ms lang=${ocr.language} lines=${ocr.lines.length} chars=${ocr.text.length}`);
console.log('ocr sample:', ocr.lines.slice(0, 3).map((l) => l.text).join(' | '));

const shot2 = await host.call('screenshot', { target: 'active_window' });
console.log('window shot', shot2.width + 'x' + shot2.height, 'masked=', shot2.masked_regions.length, shot2.ref);

await host.dispose();
