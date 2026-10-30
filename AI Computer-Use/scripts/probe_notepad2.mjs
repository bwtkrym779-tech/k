import { spawn } from 'node:child_process';
import { WinHost } from '../src/winhost/client.mjs';

const host = new WinHost({ root: process.cwd() });
await host.start();
const child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
child.unref();
let win = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const wins = await host.call('list_windows', { filter: 'Notepad' });
  win = wins.windows.find((w) => w.process.toLowerCase() === 'notepad');
  if (win) break;
}
await host.call('focus_window', { handle: win.handle });
const tree = await host.call('ui_tree', { window_handle: win.handle, depth: 8, max_nodes: 200, include_offscreen: true });
console.log(JSON.stringify(tree.nodes, null, 1).slice(0, 4000));
await host.dispose();
