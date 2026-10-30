import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Bounded task memory. Keeps the full record on disk for audit, but only a small
 * window in the prompt: the serving context is 4096 tokens, and a 7B model
 * degrades quickly when the transcript is long.
 */
export class TaskMemory {
  constructor({ config, sessionId, task }) {
    this.config = config;
    this.sessionId = sessionId;
    this.task = task;
    this.file = path.join(config.sessionDir, `${sessionId}.json`);
    this.reportFile = path.join(config.sessionDir, `${sessionId}-report.md`);
    this.steps = [];
    this.evidence = [];
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.status = 'running';
    this.note = null;
    mkdirSync(config.sessionDir, { recursive: true });
  }

  addStep(step) {
    this.steps.push({ n: this.steps.length + 1, at: new Date().toISOString(), ...step });
    if (step.verification?.status === 'VERIFIED') {
      this.evidence.push({
        step: this.steps.length,
        tool: step.tool,
        summary: summarizeVerification(step.verification),
        artifacts: step.verification?.evidence ?? null,
      });
    }
    this.save();
  }

  /** Compact transcript for the prompt: last N detailed, older one-liners. */
  transcript({ recent = 5, maxOlder = 12 } = {}) {
    const detailed = this.steps.slice(-recent);
    const older = this.steps.slice(Math.max(0, this.steps.length - recent - maxOlder), Math.max(0, this.steps.length - recent));
    const lines = [];
    if (older.length) {
      lines.push('Earlier:');
      for (const s of older) lines.push(`${s.n}. ${oneLine(s)}`);
    }
    if (detailed.length) {
      lines.push('Recent:');
      for (const s of detailed) {
        lines.push(`${s.n}. ${oneLine(s)}`);
        if (s.verification) lines.push(`   verify: ${s.verification.status} ${summarizeVerification(s.verification)}`);
        if (s.error) lines.push(`   error: ${s.error.code}: ${String(s.error.message).slice(0, 180)}`);
      }
    }
    return lines.join('\n');
  }

  finish(status, { note = null, report = null } = {}) {
    this.finishedAt = new Date().toISOString();
    this.status = status;
    this.note = note;
    this.report = report;
    this.save();
    this.writeReport();
  }

  save() {
    const record = {
      session_id: this.sessionId,
      task: this.task,
      status: this.status,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      note: this.note,
      evidence: this.evidence,
      steps: this.steps,
      report: this.report ?? null,
    };
    writeFileSync(this.file, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return this.file;
  }

  writeReport() {
    const ok = this.status === 'completed';
    const lines = [
      `# Agent session ${this.sessionId}`,
      '',
      `- Task: ${this.task}`,
      `- Status: **${this.status}**`,
      `- Started: ${this.startedAt}`,
      `- Finished: ${this.finishedAt}`,
      `- Steps: ${this.steps.length}`,
      this.note ? `- Note: ${this.note}` : '',
      '',
      '## Verified evidence',
      ...(this.evidence.length
        ? this.evidence.map((e) => `- step ${e.step} \`${e.tool}\`: ${e.summary}`)
        : ['- none (completion is not evidence-backed)']),
      '',
      '## Steps',
      ...this.steps.map((s) => `### ${s.n}. ${s.tool}\n\n- thought: ${s.thought ?? ''}\n- args: \`${String(JSON.stringify(s.args)).slice(0, 400)}\`\n- result: ${s.ok ? 'ok' : 'failed'}${s.error ? ` (${s.error.code})` : ''}\n- verification: ${s.verification?.status ?? 'n/a'}${s.verification?.recommended_next_step ? ` — ${s.verification.recommended_next_step}` : ''}`),
      '',
      ok ? 'Completion is backed by the verified evidence above.' : 'This session did not end with verified completion.',
    ];
    writeFileSync(this.reportFile, lines.filter((l) => l !== undefined).join('\n') + '\n', 'utf8');
    return this.reportFile;
  }

  /** Keep the screenshot directory bounded (count + age). */
  sweepScreenshots() {
    const dir = this.config.screenshots.dir;
    if (!existsSync(dir)) return { removed: 0 };
    const { maxFiles, maxAgeHours } = this.config.screenshots;
    const cutoff = Date.now() - maxAgeHours * 3600_000;
    let removed = 0;
    let files;
    try {
      files = readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .map((f) => {
          const full = path.join(dir, f);
          try { return { full, mtime: statSync(full).mtimeMs }; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return { removed: 0 };
    }
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (i >= maxFiles || f.mtime < cutoff) {
        try { unlinkSync(f.full); removed++; } catch { /* ignore */ }
      }
    }
    return { removed, kept: Math.min(files.length, maxFiles) };
  }

  toJSON() {
    return {
      session_id: this.sessionId,
      task: this.task,
      status: this.status,
      evidence: this.evidence,
      steps: this.steps.length,
      session_file: this.file,
      report_file: this.reportFile,
    };
  }
}

export function loadSession(config, sessionId) {
  const file = path.join(config.sessionDir, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function oneLine(s) {
  const args = JSON.stringify(s.args ?? {});
  const argText = args.length > 140 ? args.slice(0, 140) + '…' : args;
  const status = s.ok === false ? `FAILED ${s.error?.code ?? ''}` : 'ok';
  return `${s.tool} ${argText} -> ${status}${s.thought ? ` (${s.thought.slice(0, 100)})` : ''}`;
}

function summarizeVerification(v) {
  const passed = (v.checks ?? []).filter((c) => c.passed).map((c) => c.name);
  return `${v.status} [${passed.join(', ') || 'no checks'}] confidence=${v.confidence}`;
}
