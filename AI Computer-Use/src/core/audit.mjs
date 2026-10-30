import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSONL audit log plus a human-readable log. Every tool request,
 * policy decision, approval and result is recorded. Secrets are redacted before
 * anything is written to disk.
 */
export class Audit {
  constructor({ logDir, sessionId = 'session', level = 'info', echo = false }) {
    this.logDir = logDir;
    this.sessionId = sessionId;
    this.level = level;
    this.echo = echo;
    this.seq = 0;
    mkdirSync(logDir, { recursive: true });
    this.jsonlPath = path.join(logDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    this.humanPath = path.join(logDir, `agent-${new Date().toISOString().slice(0, 10)}.log`);
  }

  #write(level, event, data = {}) {
    if ((LEVELS[level] ?? 20) < (LEVELS[this.level] ?? 20)) return;
    const record = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      level,
      event,
      session: this.sessionId,
      data: redact(data),
    };
    try {
      appendFileSync(this.jsonlPath, JSON.stringify(record) + '\n', 'utf8');
    } catch { /* logging must never break execution */ }
    const summary = summarize(event, record.data);
    const line = `${record.ts} ${level.toUpperCase().padEnd(5)} ${event} ${summary}`;
    try {
      appendFileSync(this.humanPath, line + '\n', 'utf8');
    } catch { /* ignore */ }
    if (this.echo) console.log(line);
  }

  debug(event, data) { this.#write('debug', event, data); }
  info(event, data) { this.#write('info', event, data); }
  warn(event, data) { this.#write('warn', event, data); }
  error(event, data) { this.#write('error', event, data); }

  toolRequest({ tool, args, step }) {
    this.info('tool.request', { tool, args, step });
  }

  toolResult({ tool, step, ok, durationMs, result, error }) {
    this.info('tool.result', {
      tool, step, ok, duration_ms: durationMs,
      result: ok ? summarizeResult(result) : undefined,
      error: error ? { code: error.code, message: error.message } : undefined,
    });
  }
}

function summarize(event, data) {
  const parts = [];
  if (data.tool) parts.push(`tool=${data.tool}`);
  if (data.step !== undefined) parts.push(`step=${data.step}`);
  if (data.ok !== undefined) parts.push(`ok=${data.ok}`);
  if (data.duration_ms !== undefined) parts.push(`${data.duration_ms}ms`);
  if (data.decision) parts.push(`decision=${data.decision}`);
  if (data.reason) parts.push(`reason=${String(data.reason).slice(0, 160)}`);
  if (data.error?.message) parts.push(`error=${String(data.error.message).slice(0, 160)}`);
  return parts.join(' ');
}

function summarizeResult(result) {
  if (result === null || result === undefined) return result;
  if (typeof result !== 'object') return typeof result === 'string' ? result.slice(0, 300) : result;
  const keep = {};
  for (const key of ['ok', 'ref', 'path', 'count', 'title', 'handle', 'url', 'text', 'verified', 'status', 'exit_code', 'snapshot', 'element_id', 'method']) {
    if (key in result) {
      const v = result[key];
      keep[key] = typeof v === 'string' ? v.slice(0, 300) : v;
    }
  }
  return keep;
}
