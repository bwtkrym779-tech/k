import os from 'node:os';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ToolError } from '../core/errors.mjs';
import { commandPolicy, runCommand } from '../controller/desktop.mjs';

export const systemTools = [
  {
    name: 'system.get_diagnostics',
    title: 'Collect safe local diagnostics',
    category: 'system',
    permission: 'observe',
    description: 'Collect read-only diagnostics: OS version, CPU, memory, Node/runtime versions, GPU status (nvidia-smi when available), disk space and the foreground window. Use before researching an application failure.',
    inputSchema: {
      type: 'object',
      properties: {
        include_gpu: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    examples: [{}],
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const mem = { total_gb: round(os.totalmem() / 1e9), free_gb: round(os.freemem() / 1e9) };
      let gpu = null;
      if (args.include_gpu ?? true) {
        const res = await runCommand({ command: 'nvidia-smi', args: ['--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu', '--format=csv,noheader'], timeoutMs: 8000 });
        if (res.ok) gpu = res.stdout.trim().split(/\r?\n/).map((line) => line.split(',').map((s) => s.trim()));
      }
      return {
        os: { platform: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname() },
        cpu: { model: os.cpus()[0]?.model, cores: os.cpus().length, load: os.loadavg() },
        memory: mem,
        node: process.version,
        gpu,
        foreground: await ctx.perception.activeWindow(),
        workspace: ctx.config.workspace,
        note: 'Read-only diagnostics. No secrets are collected.',
      };
    },
  },
  {
    name: 'system.run_command',
    title: 'Run an allowlisted command',
    category: 'system',
    permission: 'modify',
    description: 'Run a command without a shell inside the workspace. Commands must be on the allowlist; unlisted executables, inline evaluation, package installation and write-capable git commands require explicit approval. Captures exit code, stdout and stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name or absolute path, e.g. node, npm, git' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed verbatim (no shell interpretation)' },
        cwd: { type: 'string', description: 'Working directory inside the workspace', default: '.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, default: 120000 },
        approval_id: { type: 'string', description: 'Approval id for commands outside the allowlist' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    examples: [{ command: 'node', args: ['--version'] }, { command: 'npm', args: ['test'] }],
    whenNotToUse: 'Do not use to install software, modify system settings, or run scripts downloaded from the internet.',
    handler: async (args, ctx) => {
      ctx.checkAbort();
      const argv = [args.command, ...(args.args ?? [])];
      const cwd = path.resolve(ctx.config.root, args.cwd ?? ctx.config.workspace);
      if (!ctx.config.isAllowedPath(cwd, { write: true })) {
        throw new ToolError('OUTSIDE_WORKSPACE', `Working directory is outside the workspace: ${cwd}`);
      }
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ToolError('NOT_FOUND', `Working directory not found: ${cwd}`);
      const policy = commandPolicy(argv, ctx.config);
      if (!policy.allowed) {
        ctx.ensureApproval('unlisted_command', args, { summary: `Run command: ${argv.join(' ')} (${policy.reason})`, risk: 'modify' });
      }
      const result = await runCommand({
        command: args.command,
        args: args.args ?? [],
        cwd,
        timeoutMs: args.timeout_ms ?? 120000,
      });
      return { ...result, cwd, allowlisted: policy.allowed };
    },
  },
];

function round(n) {
  return Math.round(n * 10) / 10;
}
