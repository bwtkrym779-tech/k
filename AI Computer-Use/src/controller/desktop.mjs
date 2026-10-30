import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Known, approved application launch targets. */
export function appCandidates(name) {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const map = {
    notepad: ['notepad.exe'],
    calc: ['calc.exe'],
    calculator: ['calc.exe'],
    mspaint: ['mspaint.exe'],
    paint: ['mspaint.exe'],
    explorer: ['explorer.exe'],
    code: [
      path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(pf, 'Microsoft VS Code', 'Code.exe'),
    ],
    winword: [path.join(pf, 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE')],
    excel: [path.join(pf, 'Microsoft Office', 'root', 'Office16', 'EXCEL.EXE')],
    'notepad++': [path.join(pf, 'Notepad++', 'notepad++.exe'), path.join(pf86, 'Notepad++', 'notepad++.exe')],
    cmd: [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')],
    powershell: [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
  };
  return map[name.toLowerCase()] ?? null;
}

export function resolveApplication(nameOrPath, config) {
  const direct = String(nameOrPath).trim();
  if (direct.includes('\\') || direct.includes('/') || direct.toLowerCase().endsWith('.exe')) {
    const resolved = path.resolve(config.root, direct);
    return { path: resolved, approved: config.approvedApps.includes(path.basename(resolved, '.exe').toLowerCase()), kind: 'path' };
  }
  const candidates = appCandidates(direct);
  if (candidates) {
    const found = candidates.find((c) => (c.includes('\\') ? existsSync(c) : isOnPath(c)));
    return { path: found ?? candidates[0], approved: true, kind: 'name' };
  }
  const onPath = isOnPath(`${direct}.exe`) ? `${direct}.exe` : null;
  return { path: onPath, approved: false, kind: 'unknown' };
}

export function isOnPath(exe) {
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  return dirs.some((d) => {
    try { return existsSync(path.join(d, exe)) && statSync(path.join(d, exe)).isFile(); } catch { return false; }
  });
}

export function launchProcess(exePath, args = [], { cwd } = {}) {
  const child = spawn(exePath, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.unref();
  return { pid: child.pid, path: exePath, args };
}

/** Wait until a window matching the criteria appears (or a timeout expires). */
export async function waitForWindow(perception, { beforeHandles = [], processNames = [], titleIncludes = [], timeoutMs = 12000, pollMs = 300 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const wins = await perception.listWindows();
    const all = arrayify(wins.windows);
    last = all;
    const candidates = all.filter((w) => {
      if (beforeHandles.includes(w.handle)) return false;
      const proc = String(w.process ?? '').toLowerCase();
      if (processNames.length && !processNames.some((p) => proc === p.toLowerCase())) return false;
      if (titleIncludes.length && !titleIncludes.some((t) => String(w.title ?? '').toLowerCase().includes(t.toLowerCase()))) return false;
      return w.bounds?.width > 1 && w.bounds?.height > 1;
    });
    if (candidates.length) return { found: true, window: candidates[0], elapsed_ms: Date.now() - started };
    await sleep(pollMs);
  }
  return { found: false, elapsed_ms: Date.now() - started, windows: last ?? [] };
}

export async function waitForElement(host, { name, name_contains, role, automation_id, window_handle, timeoutMs = 8000, pollMs = 400 }) {
  const started = Date.now();
  let attempts = 0;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    attempts++;
    try {
      const res = await host.call('locate_element', { name, name_contains, role, automation_id, window_handle, limit: 5 });
      const matches = arrayify(res.matches);
      if (matches.length) return { found: true, elapsed_ms: Date.now() - started, attempts, match: matches[0], snapshot: res.snapshot };
    } catch (err) {
      lastError = err;
    }
    await sleep(pollMs);
  }
  return { found: false, elapsed_ms: Date.now() - started, attempts, error: lastError?.message };
}

export function arrayify(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function commandPolicy(args, config) {
  const [cmd, ...rest] = args;
  const exe = path.basename(String(cmd ?? '')).toLowerCase().replace(/\.exe$/, '');
  if (!config.commandAllowlist.includes(exe)) {
    return { allowed: false, reason: `'${exe}' is not in the command allowlist (${config.commandAllowlist.join(', ')})` };
  }
  const joined = rest.join(' ').toLowerCase();
  if (exe === 'node' && rest.some((a) => ['-e', '--eval', '-p', '--print'].includes(a))) {
    return { allowed: false, reason: 'Inline node evaluation requires approval' };
  }
  if (exe === 'npm' && /^(install|i|add|ci|update|link|publish)\b/.test(joined)) {
    return { allowed: false, reason: 'Installing/publishing packages requires approval' };
  }
  if (exe === 'git' && !/^(status|log|diff|show|branch|rev-parse|remote)\b/.test(joined)) {
    return { allowed: false, reason: 'Only read-only git subcommands are allowlisted' };
  }
  if (/[&|<>^]/.test(rest.join(' '))) {
    return { allowed: false, reason: 'Shell metacharacters are not allowed in arguments' };
  }
  return { allowed: true };
}

/** Run a command without a shell; never interpolate into a command string. */
export async function runCommand({ command, args = [], cwd, timeoutMs = 120000, env = {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: err.message, exit_code: null, duration_ms: 0 });
      return;
    }
    const cap = 200_000;
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, exit_code: null, duration_ms: Date.now() - started });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exit_code: code,
        signal,
        timed_out: timedOut,
        stdout: stdout.slice(0, 20000),
        stderr: stderr.slice(0, 20000),
        duration_ms: Date.now() - started,
        command,
        args,
      });
    });
  });
}
