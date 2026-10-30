import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './core/config.mjs';
import { Audit } from './core/audit.mjs';
import { Approvals } from './safety/approvals.mjs';
import { Policy } from './safety/policy.mjs';
import { ToolRegistry } from './tools/registry.mjs';
import { computerTools } from './tools/computer.mjs';
import { filesystemTools } from './tools/filesystem.mjs';
import { systemTools } from './tools/system.mjs';
import { browserTools } from './tools/browser.mjs';
import { researchTools } from './tools/research.mjs';
import { visionTools } from './tools/vision.mjs';
import { WinHost } from './winhost/client.mjs';
import { Perception } from './perception/perception.mjs';
import { VisionAdapter } from './perception/vision.mjs';
import { CdpBrowser } from './browser/cdp.mjs';
import { WebResearch } from './research/web.mjs';
import { createClient } from './model/detect.mjs';
import { CancelledError, ToolError, ApprovalRequiredError } from './core/errors.mjs';

/**
 * Process-wide runtime. Everything the agent can do is constructed here so the
 * HTTP server, the CLI agent and (through the server) the OpenCode plugin share
 * exactly one implementation of policy, approvals and tool execution.
 */
export async function createRuntime({ root = process.cwd(), overrides = {}, sessionId = null, echo = false, logLevel = null } = {}) {
  const config = loadConfig(root, overrides);
  if (logLevel) config.logLevel = logLevel;
  const sid = sessionId ?? `s_${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const audit = new Audit({ logDir: config.logDir, sessionId: sid, level: config.logLevel, echo });
  const host = new WinHost({ root: config.root, screenshotDir: config.screenshots.dir });

  const approvals = new Approvals({ file: path.join(config.stateDir, 'approvals.json') });
  const policy = new Policy(config);
  policy.approvals = approvals;

  const perception = new Perception({ host, config, audit });
  const browser = new CdpBrowser({ config, audit });
  const research = new WebResearch({ config, audit });

  const registry = new ToolRegistry({ policy, audit, config });
  registry.registerAll([
    ...computerTools,
    ...filesystemTools,
    ...systemTools,
    ...browserTools,
    ...researchTools,
    ...visionTools,
  ]);

  const primary = createClient(config, { role: 'primary', audit });
  if (!primary.model) primary.model = await resolveModelName(primary);

  let vision = null;
  let visionClient = null;
  if (config.vision.enabled && config.vision.baseUrl && config.vision.model) {
    visionClient = createClient(config, { role: 'vision', audit });
    vision = new VisionAdapter({ client: visionClient, config, audit });
    perception.vision = vision;
  }

  const abort = new AbortController();
  const stopRequested = () => existsSync(config.estop.file);
  const state = { running: false, runId: null, task: null, startedAt: null, actions: 0 };

  /** Build a per-run tool context. The registry never sees shared mutable state. */
  function createContext({ autonomy = config.autonomy, run = null } = {}) {
    const ctx = {
      config,
      host,
      perception,
      browser,
      research,
      vision,
      registry,
      approvals,
      audit,
      autonomy,
      dryRun: config.dryRun,
      run,
      step: 0,
      currentTool: null,
      elementDescriptors: new Map(),
      cancelled: false,

      isCancelled() {
        return this.cancelled || abort.signal.aborted || stopRequested();
      },

      checkAbort() {
        if (this.cancelled || abort.signal.aborted) throw new CancelledError();
        if (stopRequested()) {
          throw new CancelledError(`Emergency stop requested (file: ${config.estop.file})`);
        }
      },

      /**
       * Guard for conditions discovered inside a tool handler (path outside the
       * workspace, unapproved app, unlisted command). Either consumes a valid
       * approval token bound to these exact args, or raises a request.
       */
      ensureApproval(kind, args, { summary, risk = 'modify' } = {}) {
        const toolName = this.currentTool ?? kind;
        if (args?.approval_id) {
          const result = approvals.consume(args.approval_id, toolName, args);
          if (!result.ok) throw new ToolError(result.code, result.reason);
          return result;
        }
        const request = approvals.create({ tool: toolName, args, summary, risk, requestedBy: 'agent' });
        audit.warn('approval.requested', { tool: toolName, approval: request.id, summary });
        throw new ApprovalRequiredError(request);
      },

      /** Remember a stable identity for an element id before it is invalidated. */
      async captureElement(elementId) {
        if (!elementId || this.elementDescriptors.has(elementId)) return;
        try {
          const info = await host.call('inspect_element', { element_id: elementId });
          this.elementDescriptors.set(elementId, {
            role: info.role,
            name: info.name,
            automation_id: info.automation_id,
          });
        } catch {
          // Stale/unknown ids are reported by the action itself.
        }
      },

      /**
       * Re-locate the same logical element after a new snapshot. UIA ids are
       * snapshot-scoped, so verification must never reuse them.
       */
      async resolveElementAfter(elementId) {
        const d = this.elementDescriptors.get(elementId);
        if (!d) return null;
        const query = {};
        if (d.automation_id) query.automation_id = d.automation_id;
        else if (d.name) query.name = d.name;
        if (!query.automation_id && !query.name) return null;
        if (d.role) query.role = d.role;
        const res = await host.call('locate_element', { ...query, limit: 5 }).catch(() => null);
        const matches = res?.matches ? (Array.isArray(res.matches) ? res.matches : [res.matches]) : [];
        return matches[0] ?? null;
      },
    };
    return ctx;
  }

  const runtime = {
    sid,
    config,
    audit,
    host,
    approvals,
    policy,
    perception,
    browser,
    research,
    vision,
    visionClient,
    registry,
    primary,
    state,
    abort,
    stopRequested,
    createContext,
    async start() {
      await host.start();
      audit.info('runtime.started', {
        root: config.root,
        model: primary.model,
        autonomy: config.autonomy,
        dry_run: config.dryRun,
        vision: vision?.status().available ?? false,
        tools: registry.list().length,
      });
      return runtime;
    },
    async dispose() {
      abort.abort();
      await browser.close().catch(() => null);
      await host.dispose();
    },
  };
  return runtime;
}

async function resolveModelName(client) {
  try {
    const models = await client.listModels();
    if (models.length) return models[0].id;
  } catch { /* fall through */ }
  throw new ToolError(
    'MODEL_NOT_CONFIGURED',
    'No model is configured and the endpoint did not list any models. Set endpoint.model in .agent/config.json (e.g. "model2.gguf").',
  );
}
