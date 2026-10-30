import path from 'node:path';
import { AUTONOMY_LEVELS } from '../core/config.mjs';
import { argsFingerprint } from '../core/redact.mjs';

/**
 * Permission policy. Decisions are enforced here, in the tool execution layer,
 * never only in the prompt. Levels:
 *
 *  observe     read-only perception/research; every mutating tool is denied
 *  assisted    perception + UI interaction; file writes/commands need approval
 *  supervised  perception + interaction + workspace-scoped writes (default)
 *  autonomous  same tool rights as supervised, fewer confirmation prompts
 *
 * Destructive actions ALWAYS require an explicit approval token, at every level.
 */

const LEVEL_RANK = { observe: 0, assisted: 1, supervised: 2, autonomous: 3 };

const ALWAYS_APPROVAL = new Set([
  'filesystem.delete',
  'filesystem.write_outside_workspace',
  'system.run_command.unlisted',
  'computer.open_application.unapproved',
  'browser.authenticated_session',
]);

export const RISK_LABEL = {
  observe: 'read-only observation',
  interact: 'UI interaction',
  modify: 'data modification',
  destructive: 'destructive or sensitive action',
};

export class Policy {
  constructor(config) {
    this.config = config;
    this.approvals = null; // set by the runtime
  }

  levelRank(level = this.config.autonomy) {
    return LEVEL_RANK[level] ?? -1;
  }

  /** Main decision for a tool call. */
  evaluate(tool, args, { autonomy = this.config.autonomy, approval = null } = {}) {
    const rank = this.levelRank(autonomy);
    if (rank < 0) return deny('INVALID_AUTONOMY', `Unknown autonomy level '${autonomy}'`);
    const risk = tool.permission;

    if (risk === 'observe') {
      return this.#sensitivePathCheck(tool, args) ?? allow('OBSERVE_ALLOWED', 'read-only tool');
    }

    if (rank === 0) {
      return deny('AUTONOMY_OBSERVE', `Autonomy 'observe' forbids ${risk} tool '${tool.name}'`);
    }

    if (risk === 'interact') {
      if (tool.approval === 'always') return this.#requireApproval(tool, args, approval, rank);
      return allow('INTERACT_ALLOWED', `autonomy ${autonomy} allows UI interaction`);
    }

    if (risk === 'modify') {
      const pathCheck = this.#pathCheck(tool, args);
      if (pathCheck && pathCheck.decision === 'deny') return pathCheck;
      if (rank === 1) return this.#requireApproval(tool, args, approval, rank);
      if (tool.approval === 'always') return this.#requireApproval(tool, args, approval, rank);
      return allow('MODIFY_ALLOWED', `workspace-scoped modification under ${autonomy}`);
    }

    // destructive
    return this.#requireApproval(tool, args, approval, rank);
  }

  #requireApproval(tool, args, approval, rank) {
    if (!approval) {
      return {
        decision: 'ask',
        rule: 'APPROVAL_REQUIRED',
        reason: `'${tool.name}' is ${RISK_LABEL[tool.permission]} and requires explicit user approval`,
        fingerprint: argsFingerprint(tool.name, args),
      };
    }
    if (!this.approvals) return deny('APPROVAL_UNAVAILABLE', 'Approval store is not configured');
    const result = this.approvals.consume(approval, tool.name, args);
    if (!result.ok) return deny(result.code, result.reason);
    return allow('APPROVAL_GRANTED', `approved by user (${approval})`);
  }

  #pathCheck(tool, args) {
    if (!tool.pathArgs?.length) return null;
    for (const key of tool.pathArgs) {
      const value = lookup(args, key);
      if (typeof value !== 'string' || !value) continue;
      const resolved = path.resolve(this.config.root, value);
      if (!this.config.isAllowedPath(resolved, { write: true })) {
        return {
          decision: 'ask',
          rule: 'OUTSIDE_WORKSPACE',
          reason: `Path '${resolved}' is outside the allowed workspace (${this.config.allowedDirs.join(', ')})`,
        };
      }
    }
    return null;
  }

  #sensitivePathCheck(tool, args) {
    if (!tool.pathArgs?.length) return null;
    for (const key of tool.pathArgs) {
      const value = lookup(args, key);
      if (typeof value !== 'string' || !value) continue;
      if (this.config.sensitivePatterns.some((pattern) => globMatch(pattern, value.replaceAll('\\', '/')))) {
        return deny('SENSITIVE_PATH', `Access to sensitive path '${value}' is blocked by policy`);
      }
    }
    return null;
  }

  scheduleCheck(executedActions, limits) {
    if (executedActions >= limits.maxActions) {
      return deny('ACTION_BUDGET', `Action budget exhausted (${limits.maxActions})`);
    }
    return null;
  }
}

function allow(rule, reason) { return { decision: 'allow', rule, reason }; }
function deny(rule, reason) { return { decision: 'deny', rule, reason }; }

function lookup(obj, keyPath) {
  return keyPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** Tiny glob matcher supporting **, * and ?. */
export function globMatch(pattern, value) {
  const p = pattern.replaceAll('\\', '/');
  const escaped = p
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('')
    .replace(/\.\*\*/g, '(?:.*)');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export { AUTONOMY_LEVELS, ALWAYS_APPROVAL };
