import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

/**
 * Client for the persistent PowerShell automation host (src/winhost/winhost.ps1).
 *
 * - One request in flight at a time (the host is single threaded); calls are queued.
 * - Per-request timeout; a timed-out host is killed and restarted, because a stuck
 *   UIA call could otherwise block every later request.
 * - Captures host stderr for diagnostics instead of leaking it to user output.
 */
export class WinHost extends EventEmitter {
  #child = null;
  #rl = null;
  #queue = [];
  #pending = new Map();
  #seq = 0;
  #busy = false;
  #starting = null;
  #stderr = [];
  #disposed = false;

  constructor({ root, timeoutMs = 20000, screenshotDir } = {}) {
    super();
    this.root = root ?? process.cwd();
    this.scriptPath = path.join(this.root, 'src', 'winhost', 'winhost.ps1');
    this.defaultTimeoutMs = timeoutMs;
    this.screenshotDir = screenshotDir ?? path.join(this.root, '.agent', 'screenshots');
  }

  get stderrTail() {
    return this.#stderr.slice(-40).join('\n');
  }

  async start() {
    if (this.#child && !this.#child.killed) return this;
    if (this.#starting) return this.#starting;
    this.#starting = new Promise((resolve, reject) => {
      if (!existsSync(this.scriptPath)) {
        reject(new Error(`WinHost script not found: ${this.scriptPath}`));
        return;
      }
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.scriptPath,
      ], {
        cwd: this.root,
        windowsHide: true,
        env: {
          ...process.env,
          AGENT_SCREENSHOT_DIR: this.screenshotDir,
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.#child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdin.on('error', (err) => {
        this.#stderr.push(`stdin: ${err.message}`);
      });
      readline.createInterface({ input: child.stdout }).on('line', (line) => this.#onLine(line));
      child.stderr.on('data', (chunk) => {
        this.#stderr.push(String(chunk).trim());
        if (this.#stderr.length > 200) this.#stderr.shift();
      });
      child.on('exit', (code, signal) => {
        this.emit('exit', { code, signal });
        this.#child = null;
        for (const [, entry] of this.#pending) {
          entry.reject(Object.assign(new Error(`WinHost exited (code=${code} signal=${signal})`), { code: 'HOST_EXITED' }));
        }
        this.#pending.clear();
        this.#busy = false;
        if (!this.#disposed) this.#drain();
      });
      child.on('error', (err) => reject(err));

      // Startup can take several seconds because native.cs is compiled by Add-Type.
      // The readiness ping bypasses the queue: #busy is held by the caller that is
      // waiting for start(), so a queued ping would deadlock.
      this.#rawRequest('ping', {}, 30000)
        .then(() => {
          this.emit('ready');
          resolve(this);
        })
        .catch((err) => reject(new Error(`WinHost failed to start: ${err.message}\n${this.stderrTail}`)));
    }).finally(() => { this.#starting = null; });
    return this.#starting;
  }

  #rawRequest(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.#child) {
        reject(Object.assign(new Error('WinHost is not running'), { code: 'HOST_NOT_RUNNING' }));
        return;
      }
      const id = String(++this.#seq);
      const timer = setTimeout(async () => {
        this.#pending.delete(id);
        reject(Object.assign(new Error(`WinHost request '${method}' timed out after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
        this.kill();
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#child.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n', 'utf8');
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  #onLine(line) {
    if (!line || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('protocol-error', line);
      return;
    }
    const entry = this.#pending.get(msg.id);
    if (!entry) return;
    this.#pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(Object.assign(new Error(msg.error?.message ?? 'WinHost error'), {
      code: msg.error?.code ?? 'HOST_ERROR',
      hostError: msg.error,
    }));
  }

  #drain() {
    if (this.#busy || this.#disposed) return;
    const next = this.#queue.shift();
    if (!next) {
      this.#busy = false;
      return;
    }
    this.#busy = true;
    this.#execute(next).finally(() => {
      this.#busy = false;
      this.#drain();
    });
  }

  async #execute(job) {
    try {
      if (!this.#child) throw Object.assign(new Error('WinHost is not running'), { code: 'HOST_NOT_RUNNING' });
      const id = String(++this.#seq);
      const timeoutMs = job.timeoutMs ?? this.defaultTimeoutMs;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
          this.#pending.delete(id);
          reject(Object.assign(new Error(`WinHost request '${job.method}' timed out after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
          // The host may be stuck in a blocking UIA call. Restart it.
          this.kill();
          await this.start().catch(() => {});
        }, timeoutMs);
        this.#pending.set(id, { resolve, reject, timer, method: job.method });
        const payload = JSON.stringify({ id, method: job.method, params: job.params ?? {} }) + '\n';
        this.#child.stdin.write(payload, 'utf8');
      });
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    }
  }

  call(method, params = {}, { timeoutMs } = {}) {
    if (this.#disposed) return Promise.reject(new Error('WinHost is disposed'));
    // Starting is awaited before the job enters the single-flight queue.
    return (async () => {
      if (!this.#child) await (this.#starting ?? this.start());
      return new Promise((resolve, reject) => {
        this.#queue.push({ method, params, resolve, reject, timeoutMs });
        if (!this.#busy) this.#drain();
      });
    })();
  }

  kill() {
    if (this.#child) {
      try { this.#child.kill(); } catch { /* ignore */ }
      this.#child = null;
    }
  }

  async dispose() {
    this.#disposed = true;
    this.kill();
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('WinHost disposed'));
    }
    this.#pending.clear();
  }
}
