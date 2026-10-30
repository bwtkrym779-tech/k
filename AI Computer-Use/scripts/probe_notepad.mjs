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
console.log('notepad window:', win?.title, win?.handle, win?.bounds);
if (!win) { await host.dispose(); process.exit(1); }

const focused = await host.call('focus_window', { handle: win.handle });
console.log('focus_ok:', focused.focus_ok, 'foreground:', focused.title);

const tree = await host.call('ui_tree', { window_handle: win.handle, depth: 6, max_nodes: 100 });
console.log('nodes:', tree.node_count);
for (const n of tree.nodes) console.log(' ', n.id, n.role, JSON.stringify(n.name).slice(0, 50), 'auto=', n.automation_id, 'patterns=', JSON.stringify(n.patterns));

const edit = tree.nodes.find((n) => n.role === 'Edit' || n.role === 'Document');
const arabic = 'أهلاً بك في نظام Computer Use';
const typed = await host.call('type_text', { text: arabic, element_id: edit?.id }, { timeoutMs: 30000 });
console.log('typed:', typed);

await host.call('wait', { ms: 400 });
const tree2 = await host.call('ui_tree', { window_handle: win.handle, depth: 6, max_nodes: 100 });
const edit2 = tree2.nodes.find((n) => n.role === 'Edit' || n.role === 'Document');
const insp = await host.call('inspect_element', { element_id: edit2.id });
console.log('value:', JSON.stringify(insp.value));
console.log('matches exactly:', insp.value === arabic);

const shot = await host.call('screenshot', { target: 'window', window_handle: win.handle });
console.log('shot:', shot.ref, shot.width + 'x' + shot.height, 'masked', shot.masked_regions.length);

const ocr = await host.call('ocr', { region: win.bounds });
console.log('ocr has arabic:', /Computer Use/.test(ocr.text), '| text:', ocr.text.replace(/\r?\n/g, ' / ').slice(0, 200));

// Close without saving: WM_CLOSE then handle the save prompt by choosing "Don't save" via UIA.
const closed = await host.call('close_window', { handle: win.handle });
console.log('closed:', closed);
await new Promise((r) => setTimeout(r, 800));
const dlg = await host.call('list_windows', { filter: 'Notepad' });
console.log('remaining notepad windows:', dlg.count);
if (dlg.count > 0) {
  const t = await host.call('ui_tree', { window_handle: dlg.windows[0].handle, depth: 5, max_nodes: 60 });
  const dontSave = t.nodes.find((n) => /Don.t save|No guardar|لا تحفظ/i.test(n.name ?? ''));
  console.log('dialog buttons:', t.nodes.filter((n) => n.role === 'Button').map((n) => n.name));
  if (dontSave) {
    await host.call('invoke_element', { element_id: dontSave.id });
    await new Promise((r) => setTimeout(r, 500));
    console.log('after dont-save:', (await host.call('list_windows', { filter: 'Notepad' })).count);
  }
}
await host.dispose();
