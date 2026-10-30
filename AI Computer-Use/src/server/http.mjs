import http from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createRuntime } from '../runtime.mjs';
import { runAgent, pollApproval } from '../agent/orchestrator.mjs';
import { loadSession } from '../agent/memory.mjs';

/**
 * Localhost-only tool API.
 *
 * This is the bridge between OpenCode (or any local client) and the automation
 * backend. It exposes exactly the registered tool catalog; there is no generic
 * "eval" or shell endpoint. Every call still passes through policy + approvals
 * in the registry.
 */
export async function startServer({ root = process.cwd(), port = null, host = null, echo = false } = {}) {
  const runtime = await createRuntime({ root, sessionId: `server_${Date.now()}`, echo });
  const listenHost = host ?? runtime.config.server.host;
  const listenPort = port ?? runtime.config.server.port;

  let runLock = false;
  let queue = Promise.resolve();

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const send = (status, payload) => {
      res.statusCode = status;
      res.end(JSON.stringify(payload, null, 2));
      runtime.audit.info('http.request', {
        method: req.method, path: url.pathname, status, duration_ms: Date.now() - started,
      });
    };

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, {
          ok: true,
          service: 'local-computer-use',
          version: '1.0.0',
          model: runtime.primary.model,
          endpoint: runtime.config.endpoint.baseUrl,
          autonomy: runtime.config.autonomy,
          dry_run: runtime.config.dryRun,
          vision_available: runtime.vision?.status().available ?? false,
          estop: runtime.stopRequested(),
          tools: runtime.registry.list().length,
          running: runtime.state.running,
        });
      }

      if (req.method === 'GET' && url.pathname === '/tools') {
        return send(200, { count: runtime.registry.list().length, tools: runtime.registry.publicCatalog() });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/tools/')) {
        const name = decodeURIComponent(url.pathname.slice('/tools/'.length));
        const tool = runtime.registry.get(name);
        if (!tool) return send(404, { ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool '${name}'` } });
        return send(200, {
          name: tool.name, title: tool.title, description: tool.description, category: tool.category,
          permission: tool.permission, approval: tool.approval, input_schema: tool.inputSchema,
          examples: tool.examples, when_not_to_use: tool.whenNotToUse,
        });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/tools/')) {
        const name = decodeURIComponent(url.pathname.slice('/tools/'.length));
        const body = await readJson(req);
        const autonomy = String(req.headers['x-autonomy'] ?? body.autonomy ?? runtime.config.autonomy);
        const approvalId = req.headers['x-approval-id'] ?? body.approval_id ?? null;
        const args = { ...(body.args ?? body) };
        delete args.autonomy;
        if (approvalId && !args.approval_id) args.approval_id = String(approvalId);
        // Serialise execution: snapshots and the PowerShell host are single-flight.
        const result = await (queue = queue.then(async () => {
          const ctx = runtime.createContext({ autonomy });
          return runtime.registry.execute(name, args, ctx);
        }));
        return send(result.ok ? 200 : result.approval_required ? 202 : 400, result);
      }

      if (req.method === 'GET' && url.pathname === '/approvals') {
        const status = url.searchParams.get('status') ?? 'pending';
        return send(200, { approvals: runtime.approvals.list({ status }) });
      }

      const approvalMatch = /^\/approvals\/([^/]+)\/(grant|deny)$/.exec(url.pathname);
      if (req.method === 'POST' && approvalMatch) {
        const id = decodeURIComponent(approvalMatch[1]);
        const action = approvalMatch[2];
        const body = await readJson(req).catch(() => ({}));
        const result = action === 'grant'
          ? runtime.approvals.grant(id, { by: body.by ?? 'local-user', reason: body.reason ?? null })
          : runtime.approvals.deny(id, { by: body.by ?? 'local-user', reason: body.reason ?? null });
        return send(result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && (url.pathname === '/estop' || url.pathname === '/estop/clear')) {
        if (url.pathname === '/estop') {
          writeFileSync(runtime.config.estop.file, `${new Date().toISOString()} emergency stop requested via HTTP\n`, 'utf8');
          runtime.abort.abort();
          runtime.audit.error('estop.engaged', { via: 'http' });
          return send(200, { stopped: true, file: runtime.config.estop.file, note: 'Stop file written and active runs cancelled.' });
        }
        if (existsSync(runtime.config.estop.file)) rmSync(runtime.config.estop.file, { force: true });
        runtime.audit.warn('estop.cleared', { via: 'http' });
        return send(200, { stopped: false, note: 'Stop file removed. A new runtime/process is required before running tasks again.' });
      }

      if (req.method === 'POST' && url.pathname === '/agent/run') {
        const body = await readJson(req);
        if (!body.task) return send(400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'task is required' } });
        if (runLock) return send(409, { ok: false, error: { code: 'AGENT_BUSY', message: 'Another agent run is in progress on this server.' } });
        runLock = true;
        runtime.state.running = true;
        try {
          const approvalMode = body.approval_mode ?? 'wait';
          const events = [];
          const result = await runAgent(runtime, {
            task: body.task,
            autonomy: body.autonomy ?? runtime.config.autonomy,
            maxSteps: body.max_steps ?? runtime.config.limits.maxSteps,
            maxActions: body.max_actions ?? runtime.config.limits.maxActions,
            windowHandle: body.window_handle ?? null,
            onEvent: (e) => events.push(e),
            onApproval: approvalMode === 'wait'
              ? (request) => pollApproval(runtime.approvals, request.id, { timeoutMs: 10 * 60_000 })
              : null,
          });
          return send(200, { ...result, events: events.slice(-80) });
        } finally {
          runLock = false;
          runtime.state.running = false;
        }
      }

      if (req.method === 'GET' && url.pathname.startsWith('/sessions/')) {
        const id = decodeURIComponent(url.pathname.slice('/sessions/'.length));
        const session = loadSession(runtime.config, id);
        if (!session) return send(404, { ok: false, error: { code: 'NOT_FOUND', message: `No session '${id}'` } });
        return send(200, session);
      }

      if (req.method === 'GET' && url.pathname === '/') {
        return send(200, {
          service: 'local-computer-use',
          endpoints: [
            'GET /health', 'GET /tools', 'GET /tools/:name', 'POST /tools/:name',
            'GET /approvals', 'POST /approvals/:id/grant', 'POST /approvals/:id/deny',
            'POST /agent/run', 'GET /sessions/:id', 'POST /estop', 'POST /estop/clear',
          ],
        });
      }

      return send(404, { ok: false, error: { code: 'NOT_FOUND', message: `No route ${req.method} ${url.pathname}` } });
    } catch (err) {
      const status = err.code === 'BODY_TOO_LARGE' ? 413 : err.code === 'INVALID_JSON' ? 400 : 500;
      return send(status, { ok: false, error: { code: err.code ?? 'INTERNAL', message: err.message } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const info = { host: address.address, port: address.port, url: `http://${listenHost}:${address.port}`, runtime, server };
  runtime.audit.info('server.listening', { url: info.url, tools: runtime.registry.list().length });
  return info;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(Object.assign(new Error('Request body exceeds 2MB'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch (err) {
        reject(Object.assign(new Error(`Invalid JSON body: ${err.message}`), { code: 'INVALID_JSON' }));
      }
    });
    req.on('error', reject);
  });
}
