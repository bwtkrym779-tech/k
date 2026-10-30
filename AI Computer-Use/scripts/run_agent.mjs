#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import readline from 'node:readline/promises';
import { createRuntime } from '../src/runtime.mjs';
import { runAgent } from '../src/agent/orchestrator.mjs';

/**
 * CLI agent.
 *
 *   node scripts/run_agent.mjs "open notepad and type Hello"
 *   node scripts/run_agent.mjs --task-file task.txt --autonomy supervised --max-steps 12
 *   node scripts/run_agent.mjs "…" --dry-run --json
 */

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [key, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags.set(key, inline);
    else if (['dry-run', 'json', 'echo', 'non-interactive'].includes(key)) flags.set(key, true);
    else flags.set(key, argv[++i]);
  } else {
    positional.push(a);
  }
}

const task = flags.get('task-file') ? readFileSync(String(flags.get('task-file')), 'utf8').trim() : positional.join(' ').trim();
if (!task) {
  console.error('Usage: node scripts/run_agent.mjs "<task>" [--autonomy supervised] [--max-steps 12] [--max-actions 30] [--dry-run] [--json]');
  process.exit(2);
}

const root = process.cwd();
const runtime = await createRuntime({
  root,
  echo: Boolean(flags.get('echo')),
  overrides: {
    ...(flags.has('dry-run') ? { dryRun: true } : {}),
    ...(flags.has('autonomy') ? { autonomy: String(flags.get('autonomy')) } : {}),
    ...(flags.has('model') ? { endpoint: { model: String(flags.get('model')) } } : {}),
  },
});
const json = Boolean(flags.get('json'));
const interactive = !json && !flags.get('non-interactive') && process.stdin.isTTY;
const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

const onEvent = (e) => {
  if (json) return;
  switch (e.type) {
    case 'started':
      console.log(`\n▶ ${e.task}\n  model=${e.model} autonomy=${e.autonomy} max_steps=${e.limits.maxSteps}\n`);
      break;
    case 'model.action':
      console.log(`[${e.step}] ${e.thought || '(no thought)'}`);
      console.log(`    → ${e.tool} ${JSON.stringify(e.args).slice(0, 220)}`);
      break;
    case 'verification':
      console.log(`    ✓ ${e.verification.status} (${e.verification.confidence}) ${(e.verification.checks ?? []).filter((c) => c.passed).map((c) => c.name).join(', ')}`);
      break;
    case 'step.failed':
      console.log(`    ✗ ${e.error?.code}: ${e.error?.message}`);
      break;
    case 'protocol.retry':
      console.log(`    ! malformed model response (${e.reason}); retrying`);
      break;
    case 'approval.required':
      console.log(`\n⚠ APPROVAL REQUIRED: ${e.request.summary}`);
      console.log(`  id: ${e.request.id} · risk: ${e.request.risk} · expires: ${e.request.expires_at}`);
      break;
    case 'completion.rejected':
      console.log(`    ! completion rejected: ${e.reason}`);
      break;
    default:
      break;
  }
};

const onApproval = interactive
  ? async (request) => {
      const answer = await rl.question(`\nApprove '${request.summary}'? [y/N] `);
      return /^y(es)?$/i.test(answer.trim()) ? 'granted' : 'denied';
    }
  : null;

const result = await runAgent(runtime, {
  task,
  autonomy: String(flags.get('autonomy') ?? runtime.config.autonomy),
  maxSteps: flags.has('max-steps') ? Number(flags.get('max-steps')) : runtime.config.limits.maxSteps,
  maxActions: flags.has('max-actions') ? Number(flags.get('max-actions')) : runtime.config.limits.maxActions,
  windowHandle: flags.has('window') ? Number(flags.get('window')) : null,
  onEvent,
  onApproval,
});

if (rl) rl.close();

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n■ ${result.status.toUpperCase()}`);
  if (result.summary) console.log(`  ${result.summary}`);
  if (result.note) console.log(`  note: ${result.note}`);
  if (result.error) console.log(`  error: ${result.error.code}: ${result.error.message}`);
  if (result.approval) console.log(`  approval: ${result.approval.id} (see node scripts/approvals.mjs)`);
  if (result.question) console.log(`  question: ${result.question}`);
  console.log(`  steps=${result.steps} actions=${result.actions_executed} model_calls=${result.model_calls} ${Math.round(result.duration_ms / 1000)}s`);
  console.log(`  verified evidence: ${result.verified_evidence.length}`);
  for (const e of result.verified_evidence) console.log(`    - step ${e.step} ${e.tool}: ${e.summary}`);
  console.log(`  report: ${result.files.report}`);
}

await runtime.dispose();
process.exit(result.status === 'completed' ? 0 : result.status === 'needs_input' ? 3 : 1);
