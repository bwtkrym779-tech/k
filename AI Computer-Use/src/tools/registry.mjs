import { validateSchema } from '../core/schema.mjs';
import { ToolError, CancelledError, ApprovalRequiredError, errorEnvelope } from '../core/errors.mjs';
import { argsFingerprint } from '../core/redact.mjs';

/**
 * Single source of truth for the tool catalog. Each tool is:
 *   name, title, description, category, permission, approval, inputSchema,
 *   pathArgs (for filesystem policy), handler(args, ctx), examples, whenNotToUse
 *
 * The OpenCode plugin fetches this catalog at startup and registers every entry
 * as an OpenCode tool, so documentation and runtime schemas cannot drift.
 */
export class ToolRegistry {
  constructor({ policy, audit, config }) {
    this.tools = new Map();
    this.policy = policy;
    this.audit = audit;
    this.config = config;
    this.order = [];
  }

  register(def) {
    if (!def.name || typeof def.name !== 'string') throw new Error('Tool definition requires a name');
    if (this.tools.has(def.name)) throw new Error(`Duplicate tool '${def.name}'`);
    if (typeof def.handler !== 'function') throw new Error(`Tool '${def.name}' has no handler`);
    for (const field of ['title', 'description', 'category', 'permission', 'inputSchema']) {
      if (!def[field]) throw new Error(`Tool '${def.name}' is missing '${field}'`);
    }
    const normalized = {
      approval: 'policy',
      pathArgs: [],
      examples: [],
      whenNotToUse: [],
      ...def,
      inputSchema: def.inputSchema,
    };
    this.tools.set(def.name, normalized);
    this.order.push(def.name);
    return normalized;
  }

  registerAll(defs) {
    for (const def of defs) this.register(def);
    return this;
  }

  get(name) {
    return this.tools.get(name) ?? null;
  }

  list() {
    return this.order.map((n) => this.tools.get(n));
  }

  /** Catalog for OpenCode tool registration (no handler functions). */
  publicCatalog() {
    return this.list().map((t) => ({
      name: t.name,
      opencode_name: t.name.replaceAll('.', '_').replaceAll('-', '_'),
      title: t.title,
      description: t.description,
      category: t.category,
      permission: t.permission,
      approval: t.approval,
      inputSchema: t.inputSchema,
      examples: t.examples,
      whenNotToUse: t.whenNotToUse,
    }));
  }

  /** Compact catalog injected into the reasoning prompt. */
  promptCatalog() {
    return this.list().map((t) => ({
      name: t.name,
      purpose: t.description.split('. ')[0] + '.',
      permission: t.permission,
      input: compactSchema(t.inputSchema),
    }));
  }

  async execute(name, rawArgs, ctx) {
    const tool = this.get(name);
    if (!tool) {
      return errorEnvelope(new ToolError('UNKNOWN_TOOL', `Tool '${name}' is not registered. Only registered tools with validated arguments may execute.`));
    }
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
    const validation = validateSchema(tool.inputSchema, args);
    if (!validation.valid) {
      return errorEnvelope(new ToolError('INVALID_ARGUMENTS', `Invalid arguments for ${name}: ${validation.errors.join('; ')}`, { errors: validation.errors }));
    }
    if (ctx.isCancelled?.()) {
      return errorEnvelope(new CancelledError());
    }
    const decision = this.policy.evaluate(tool, args, {
      autonomy: ctx.autonomy ?? this.config.autonomy,
      approval: args.approval_id ?? null,
    });
    this.audit?.info('policy.decision', {
      tool: name,
      decision: decision.decision,
      rule: decision.rule,
      reason: decision.reason,
      args,
      step: ctx.step,
    });
    if (decision.decision === 'deny') {
      return { ok: false, error: { code: decision.rule, message: decision.reason }, permission: decision };
    }
    if (decision.decision === 'ask') {
      const request = ctx.approvals.create({
        tool: name,
        args,
        summary: describeCall(tool, args),
        risk: tool.permission,
      });
      return errorEnvelope(new ApprovalRequiredError(request));
    }

    if (this.config.dryRun && tool.permission !== 'observe') {
      this.audit?.info('tool.dry_run', { tool: name, args, step: ctx.step });
      return {
        ok: true,
        tool: name,
        dry_run: true,
        permission: decision,
        result: { planned: { tool: name, args }, executed: false, note: 'dry-run mode: action was validated but not executed' },
        duration_ms: 0,
      };
    }

    this.audit?.toolRequest({ tool: name, args, step: ctx.step });
    const started = Date.now();
    const timeoutMs = Math.min(tool.timeoutMs ?? this.config.limits.actionTimeoutMs, this.config.limits.actionTimeoutMs);
    let timer;
    try {
      const result = await Promise.race([
        tool.handler(args, ctx),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ToolError('TIMEOUT', `Tool '${name}' exceeded ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (ctx.isCancelled?.()) return errorEnvelope(new CancelledError());
      const duration = Date.now() - started;
      this.audit?.toolResult({ tool: name, step: ctx.step, ok: true, durationMs: duration, result });
      return { ok: true, tool: name, permission: decision, result, duration_ms: duration };
    } catch (err) {
      clearTimeout(timer);
      const duration = Date.now() - started;
      this.audit?.toolResult({
        tool: name, step: ctx.step, ok: false, durationMs: duration,
        error: { code: err.code ?? 'INTERNAL', message: err.message },
      });
      return errorEnvelope(err);
    }
  }
}

function describeCall(tool, args) {
  const preview = Object.entries(args)
    .filter(([k]) => k !== 'approval_id')
    .map(([k, v]) => `${k}=${JSON.stringify(v)?.slice(0, 120)}`)
    .join(', ');
  return `${tool.name} (${preview}) ${tool.approvalReason ?? ''}`.trim();
}

function compactSchema(schema) {
  if (!schema?.properties) return {};
  const out = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    const type = Array.isArray(v.type) ? v.type.join('|') : v.type ?? (v.enum ? 'enum' : 'any');
    const bits = [type];
    if (v.enum) bits.push(`one of ${v.enum.join('|')}`);
    if (v.default !== undefined) bits.push(`default ${JSON.stringify(v.default)}`);
    out[k] = bits.join(' ');
  }
  return { fields: out, required: schema.required ?? [] };
}

export { argsFingerprint };
