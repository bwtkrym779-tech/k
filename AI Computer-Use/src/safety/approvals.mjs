import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { argsFingerprint, redact } from '../core/redact.mjs';

/**
 * Durable approval store. A destructive/high-risk tool call returns
 * {decision:"ask"} with a request id. Only an explicit user action can mint the
 * approval token; the token is single-use and bound to the exact tool + args
 * fingerprint, so a model cannot "reuse" a prior approval for a new target.
 */
export class Approvals {
  constructor({ file, ttlMinutes = 10 }) {
    this.file = file;
    this.ttlMinutes = ttlMinutes;
    mkdirSync(path.dirname(file), { recursive: true });
    this.requests = this.#load();
  }

  #load() {
    if (!existsSync(this.file)) return {};
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  #save() {
    writeFileSync(this.file, JSON.stringify(this.requests, null, 2) + '\n', 'utf8');
  }

  create({ tool, args, summary, risk, requestedBy = 'agent' }) {
    const id = `apr_${randomUUID().slice(0, 8)}`;
    const request = {
      id,
      tool,
      args_fingerprint: argsFingerprint(tool, args),
      args_preview: redact(args ?? {}),
      summary,
      risk,
      status: 'pending',
      requested_by: requestedBy,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + this.ttlMinutes * 60_000).toISOString(),
      decided_by: null,
      decided_at: null,
      reason: null,
    };
    this.requests[id] = request;
    this.#save();
    return request;
  }

  grant(id, { by = 'user', reason = null } = {}) {
    const req = this.requests[id];
    if (!req) return { ok: false, code: 'APPROVAL_NOT_FOUND', reason: `Unknown approval id '${id}'` };
    if (req.status !== 'pending') return { ok: false, code: 'APPROVAL_NOT_PENDING', reason: `Approval '${id}' is ${req.status}` };
    if (Date.now() > Date.parse(req.expires_at)) {
      req.status = 'expired';
      this.#save();
      return { ok: false, code: 'APPROVAL_EXPIRED', reason: `Approval '${id}' expired` };
    }
    req.status = 'granted';
    req.decided_by = by;
    req.decided_at = new Date().toISOString();
    req.reason = reason;
    this.#save();
    return { ok: true, request: req };
  }

  deny(id, { by = 'user', reason = null } = {}) {
    const req = this.requests[id];
    if (!req) return { ok: false, code: 'APPROVAL_NOT_FOUND', reason: `Unknown approval id '${id}'` };
    req.status = 'denied';
    req.decided_by = by;
    req.decided_at = new Date().toISOString();
    req.reason = reason;
    this.#save();
    return { ok: true, request: req };
  }

  /** Validate and burn a granted approval token for the exact call. */
  consume(id, tool, args) {
    const req = this.requests[id];
    if (!req) return { ok: false, code: 'APPROVAL_NOT_FOUND', reason: `Unknown approval id '${id}'` };
    if (req.tool !== tool) return { ok: false, code: 'APPROVAL_TOOL_MISMATCH', reason: `Approval is for '${req.tool}', not '${tool}'` };
    if (req.args_fingerprint !== argsFingerprint(tool, args)) {
      return { ok: false, code: 'APPROVAL_ARGS_MISMATCH', reason: 'Approval does not match the exact arguments of this call' };
    }
    if (req.status === 'pending' && Date.now() > Date.parse(req.expires_at)) {
      req.status = 'expired';
      this.#save();
      return { ok: false, code: 'APPROVAL_EXPIRED', reason: `Approval '${id}' expired` };
    }
    if (req.status !== 'granted') return { ok: false, code: 'APPROVAL_NOT_GRANTED', reason: `Approval '${id}' is ${req.status}` };
    if (req.status === 'granted' && req.consumed_at) return { ok: false, code: 'APPROVAL_CONSUMED', reason: `Approval '${id}' was already used` };
    req.consumed_at = new Date().toISOString();
    req.status = 'consumed';
    this.#save();
    return { ok: true };
  }

  get(id) {
    return this.requests[id] ?? null;
  }

  list({ status = 'pending' } = {}) {
    return Object.values(this.requests)
      .filter((r) => !status || r.status === status)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  prune() {
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    for (const [id, req] of Object.entries(this.requests)) {
      if (Date.parse(req.created_at) < cutoff) delete this.requests[id];
    }
    this.#save();
  }
}
