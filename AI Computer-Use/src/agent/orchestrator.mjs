import { buildSystemPrompt, buildMessages, parseModelAction, responseFormat, formatObservation, formatVerification } from './prompt.mjs';
import { TaskMemory } from './memory.mjs';
import { needsAfterObservation, verifyStep } from '../verification/engine.mjs';
import { CancelledError, ToolError } from '../core/errors.mjs';
import { stableStringify } from '../core/redact.mjs';

const DESKTOP_ACTION = /^computer\.(click|double_click|right_click|type_text|press_key|hotkey|drag|scroll|open_application|close_window|focus_window)$/;
const VERIFY_TOOLS = new Set(['filesystem.write_text', 'filesystem.delete', 'system.run_command', 'browser.navigate', 'browser.fill', 'browser.click']);

/**
 * Bounded agent loop.
 *
 * Invariants:
 *  - one validated action per model turn;
 *  - a hard cap on steps, actions, wall time and repeated calls;
 *  - a destructive/high-risk call can only run with a user-minted token bound
 *    to its exact tool + arguments;
 *  - "completed" requires at least one VERIFIED check, never model prose.
 */
export async function runAgent(runtime, {
  task,
  autonomy = runtime.config.autonomy,
  maxSteps = runtime.config.limits.maxSteps,
  maxActions = runtime.config.limits.maxActions,
  maxDurationMs = runtime.config.limits.maxDurationMs,
  windowHandle = null,
  onEvent = null,
  onApproval = null,
  sessionId = null,
  approvalTimeoutMs = 10 * 60_000,
} = {}) {
  if (!task || typeof task !== 'string') throw new Error('runAgent requires a task string');
  await runtime.start();

  const config = runtime.config;
  const sid = sessionId ?? `agent_${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 6)}`;
  const memory = new TaskMemory({ config, sessionId: sid, task });
  const ctx = runtime.createContext({ autonomy });
  const limits = {
    ...config.limits,
    maxSteps: Math.max(1, Math.min(maxSteps, 200)),
    maxActions: Math.max(1, Math.min(maxActions, 500)),
    maxDurationMs: Math.max(5000, maxDurationMs),
  };
  const started = Date.now();
  const emit = (type, data = {}) => {
    try { onEvent?.({ type, at: new Date().toISOString(), session_id: sid, ...data }); } catch { /* listeners must not break the run */ }
  };

  let actions = 0;
  let modelCalls = 0;
  let consecutiveFailures = 0;
  let completionClaims = 0;
  let repeatKey = null;
  let repeatCount = 0;
  let observation = null;
  let lastVerification = null;
  let lastError = null;

  const system = buildSystemPrompt({
    registry: runtime.registry,
    autonomy,
    dryRun: config.dryRun,
    visionAvailable: Boolean(runtime.vision?.status().available),
  });

  const finish = (status, extra = {}) => {
    const duration = Date.now() - started;
    const report = {
      session_id: sid,
      status,
      task,
      autonomy,
      duration_ms: duration,
      model_calls: modelCalls,
      actions_executed: actions,
      steps: memory.steps.length,
      verified_evidence: memory.evidence,
      ...extra,
    };
    memory.finish(status, { note: extra.note ?? null, report });
    emit('finished', report);
    return {
      ...report,
      summary: extra.summary ?? null,
      error: extra.error ?? null,
      approval: extra.approval ?? null,
      question: extra.question ?? null,
      files: { session: memory.file, report: memory.reportFile },
    };
  };

  emit('started', { task, autonomy, model: runtime.primary.model, limits });

  try {
    ctx.checkAbort();
    observation = await safeObserve(ctx, { windowHandle, includeOcr: false });
    memory.sweepScreenshots();

    for (let step = 1; step <= limits.maxSteps; step++) {
      ctx.step = step;
      ctx.checkAbort();
      if (Date.now() - started > limits.maxDurationMs) {
        return finish('timeout', { note: `Wall-clock budget of ${limits.maxDurationMs}ms exhausted` });
      }
      if (actions >= limits.maxActions) {
        return finish('step_limit', { note: `Action budget of ${limits.maxActions} exhausted` });
      }

      const budgetText = `STEP ${step}/${limits.maxSteps} · actions ${actions}/${limits.maxActions} · elapsed ${Math.round((Date.now() - started) / 1000)}s`;
      const messages = buildMessages({
        system,
        task,
        observationText: observation ? formatObservation(runtime.perception, observation) : 'Observation unavailable; capture a screenshot or read the UI tree.',
        memoryText: memory.transcript({ recent: 4, maxOlder: 8 }),
        verificationText: formatVerification(lastVerification),
        lastError,
        budgetText,
      });

      let parsed = null;
      for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
        ctx.checkAbort();
        let response;
        try {
          response = await runtime.primary.chat({
            messages,
            responseFormat: responseFormat(),
            maxTokens: Math.min(config.endpoint.maxOutputTokens, 700),
            temperature: attempt === 0 ? config.endpoint.temperature : 0,
          });
          modelCalls++;
        } catch (err) {
          lastError = `Model request failed: ${err.message}`;
          emit('model.error', { step, error: { code: err.code ?? 'MODEL_ERROR', message: err.message } });
          if (attempt === 2) return finish('failed', { error: { code: err.code ?? 'MODEL_ERROR', message: err.message } });
          continue;
        }
        const candidate = parseModelAction(response.content);
        if (candidate.action) {
          parsed = candidate;
        } else {
          lastError = `Invalid response (${candidate.error}). Reply with exactly one JSON object: {"thought":"...","action":{"tool":"...","args":{}}}`;
          emit('protocol.retry', { step, attempt: attempt + 1, reason: candidate.error, sample: response.content.slice(0, 200) });
        }
      }
      if (!parsed) {
        return finish('failed', { error: { code: 'MODEL_PROTOCOL_ERROR', message: lastError } });
      }
      lastError = null;
      const { thought, action } = parsed;
      const tool = action.tool;
      let args = action.args;
      emit('model.action', { step, thought, tool, args });

      // ---- protocol actions ----
      if (tool === 'task.complete') {
        if (memory.evidence.length > 0) {
          return finish('completed', {
            summary: String(args.summary ?? '').slice(0, 2000) || 'Task completed with verified evidence.',
            claimed_evidence: arrayify(args.evidence).map(String),
          });
        }
        completionClaims++;
        if (completionClaims >= 2) {
          return finish('unverified_completion', {
            note: 'The model declared completion twice but no step was verified.',
            summary: String(args.summary ?? '').slice(0, 1000) || null,
          });
        }
        lastError = 'Completion rejected: no VERIFIED evidence exists yet. Perform an action and verify it, or call task.fail with the blocker.';
        memory.addStep({ tool, args, thought, ok: false, error: { code: 'NO_EVIDENCE', message: lastError } });
        emit('completion.rejected', { step, reason: lastError });
        continue;
      }
      if (tool === 'task.fail') {
        return finish('failed', {
          note: String(args.reason ?? 'model gave up').slice(0, 1000),
          error: { code: 'TASK_FAILED', message: String(args.reason ?? 'model gave up').slice(0, 1000), attempted: arrayify(args.attempted) },
        });
      }
      if (tool === 'task.ask_user') {
        return finish('needs_input', {
          question: String(args.question ?? '').slice(0, 1000),
          options: arrayify(args.options).map(String),
          note: 'Waiting for the user to answer.',
        });
      }
      if (tool === 'task.wait') {
        const ms = Math.max(100, Math.min(Number(args.ms) || 1000, 10_000));
        await sleep(ms);
        observation = await safeObserve(ctx, { windowHandle, includeOcr: false });
        memory.addStep({ tool, args: { ms }, thought, ok: true });
        emit('step.wait', { step, ms });
        continue;
      }

      // ---- repetition guard ----
      const key = `${tool}:${stableStringify(args)}`;
      if (key === repeatKey) {
        repeatCount++;
      } else {
        repeatKey = key;
        repeatCount = 1;
      }
      if (repeatCount > limits.maxRepeatedActions + 1) {
        return finish('failed', {
          error: { code: 'REPEATED_ACTION', message: `Same tool call repeated ${repeatCount} times: ${tool}` },
          note: 'Stopped to avoid an infinite loop. Inspect the UI and choose a different strategy.',
        });
      }

      const isDesktopAction = DESKTOP_ACTION.test(tool);
      const before = isDesktopAction ? observation : null;
      if (args.element_id) await ctx.captureElement(args.element_id);

      ctx.currentTool = tool;
      let envelope = await runtime.registry.execute(tool, args, ctx);

      // ---- approval pause / inline decision ----
      if (envelope.approval_required) {
        const request = envelope.approval_required;
        emit('approval.required', { step, request });
        let decision = 'defer';
        try {
          decision = (await onApproval?.(request, { runtime, ctx, step })) ?? 'defer';
        } catch (err) {
          emit('approval.callback_error', { step, error: err.message });
        }
        if (decision === 'granted') {
          const granted = runtime.approvals.grant(request.id, { by: 'user' });
          if (!granted.ok) {
            lastError = `Approval ${request.id} could not be granted: ${granted.reason}`;
          } else {
            const retryArgs = { ...args, approval_id: request.id };
            if (retryArgs.element_id) {
              const relooked = await ctx.resolveElementAfter(retryArgs.element_id).catch(() => null);
              if (relooked) retryArgs.element_id = relooked.id;
            }
            args = retryArgs;
            envelope = await runtime.registry.execute(tool, args, ctx);
            if (envelope.approval_required) {
              return finish('awaiting_approval', {
                approval: envelope.approval_required,
                note: 'A second approval was requested for the same step; resolve it explicitly.',
              });
            }
          }
        } else if (decision === 'denied') {
          runtime.approvals.deny(request.id, { by: 'user' });
          memory.addStep({ tool, args, thought, ok: false, error: { code: 'APPROVAL_DENIED', message: 'user denied the action' }, approval: request });
          return finish('denied', {
            approval: request,
            note: `User denied '${tool}'. No action was executed.`,
            error: { code: 'APPROVAL_DENIED', message: 'user denied the action' },
          });
        } else {
          return finish('awaiting_approval', {
            approval: request,
            note: `Approve with: node scripts/approvals.mjs grant ${request.id} — then re-run the task. Nothing was executed.`,
          });
        }
      }
      ctx.currentTool = null;

      if (envelope.ok) actions++;

      // ---- verification ----
      let after = null;
      let verification = null;
      if (envelope.ok && (isDesktopAction || needsAfterObservation(tool))) {
        await sleep(180);
        after = await safeObserve(ctx, { windowHandle, includeOcr: tool === 'computer.type_text' });
        verification = await verifyStep({ tool, args, result: envelope.result, before, after, ctx }).catch((err) => ({
          action: tool,
          status: 'UNVERIFIED',
          success: null,
          confidence: 0,
          checks: [],
          evidence: {},
          recommended_next_step: `Verification failed to run: ${err.message}`,
        }));
      } else if (envelope.ok && VERIFY_TOOLS.has(tool)) {
        verification = await verifyStep({ tool, args, result: envelope.result, before, after, ctx }).catch(() => null);
      }
      if (after) observation = after;
      else if (envelope.ok && tool === 'computer.get_screenshot') {
        observation = await safeObserve(ctx, { windowHandle, includeOcr: false });
      }
      lastVerification = verification;

      if (!envelope.ok) {
        consecutiveFailures++;
        lastError = `${envelope.error?.code}: ${envelope.error?.message}`;
        memory.addStep({ tool, args, thought, ok: false, error: envelope.error, verification });
        emit('step.failed', { step, tool, error: envelope.error });
        if (envelope.error?.code === 'CANCELLED') return finish('cancelled', { note: envelope.error.message });
        if (consecutiveFailures >= limits.consecutiveFailureLimit) {
          return finish('failed', {
            error: { code: 'CONSECUTIVE_FAILURES', message: `${consecutiveFailures} consecutive actions failed. Last: ${lastError}` },
            note: 'Recovery limit reached; stopping rather than retrying blindly.',
          });
        }
        continue;
      }

      consecutiveFailures = 0;
      memory.addStep({ tool, args, thought, ok: true, result: compactResult(envelope.result), verification });
      emit('step.done', { step, tool, result: compactResult(envelope.result), verification });
    }

    return finish('step_limit', { note: `Step budget of ${limits.maxSteps} exhausted without a verified completion.` });
  } catch (err) {
    if (err instanceof CancelledError || err.code === 'CANCELLED') {
      return finish('cancelled', { note: err.message, error: { code: 'CANCELLED', message: err.message } });
    }
    emit('run.error', { error: { code: err.code ?? 'INTERNAL', message: err.message } });
    return finish('error', { error: { code: err.code ?? 'INTERNAL', message: err.message, details: err.details ?? null } });
  }
}

async function safeObserve(ctx, { windowHandle = null, includeOcr = false } = {}) {
  try {
    return await ctx.perception.observe({ windowHandle, includeOcr });
  } catch (err) {
    ctx.audit?.warn('perception.observe_failed', { error: err.message, code: err.code });
    return null;
  }
}

function compactResult(result) {
  if (result === null || result === undefined) return null;
  if (typeof result !== 'object') return result;
  const keep = {};
  for (const k of ['ref', 'path', 'sha256', 'width', 'height', 'count', 'title', 'handle', 'url', 'verified', 'grounding', 'launched', 'window_found', 'deleted', 'still_exists', 'exit_code', 'method', 'element_id', 'lines', 'text']) {
    if (k in result) {
      const v = result[k];
      keep[k] = typeof v === 'string' ? v.slice(0, 300) : Array.isArray(v) ? `[${v.length} items]` : v;
    }
  }
  return keep;
}

function arrayify(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Default non-interactive approval strategy for the HTTP server: wait for the
 * user to grant/deny in another client, up to the approval TTL.
 */
export async function pollApproval(approvals, requestId, { timeoutMs = 10 * 60_000, intervalMs = 500, signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return 'defer';
    const req = approvals.get(requestId);
    if (!req) return 'defer';
    if (req.status === 'granted') return 'granted';
    if (req.status === 'denied') return 'denied';
    if (req.status === 'expired') return 'defer';
    await sleep(intervalMs);
  }
  return 'defer';
}

export { ToolError };
