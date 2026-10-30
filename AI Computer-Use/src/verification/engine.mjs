import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ACTION_TOOLS = new Set([
  'computer.click', 'computer.double_click', 'computer.right_click', 'computer.type_text',
  'computer.press_key', 'computer.hotkey', 'computer.drag', 'computer.scroll',
  'computer.focus_window', 'computer.open_application', 'computer.close_window',
  'browser.click', 'browser.fill', 'browser.navigate', 'browser.scroll',
  'system.run_command', 'filesystem.write_text', 'filesystem.delete',
]);

export function needsAfterObservation(toolName) {
  return ACTION_TOOLS.has(toolName);
}

/**
 * Verify a meaningful action from observable evidence. Never trusts the model's
 * claim of success: each verification returns checks with evidence and a
 * confidence, and can be `unverified` when the evidence is insufficient.
 */
export async function verifyStep({ tool, args, result, before, after, ctx }) {
  const checks = [];
  const add = (name, passed, evidence, weight = 1) => checks.push({ name, passed, evidence, weight });
  let success = null;
  let confidence = 0;
  let next = null;

  const beforeShot = before?.screenshot;
  const afterShot = after?.screenshot;
  const change = beforeShot && afterShot ? await ctx.perception.compare(beforeShot, afterShot).catch(() => null) : null;
  const windowChanged = before?.window?.handle !== after?.window?.handle
    || before?.window?.title !== after?.window?.title;

  switch (tool) {
    case 'computer.open_application': {
      add('process_launched', Boolean(result.launched), { pid: result.pid, exe: result.executable });
      const wins = await ctx.host.call('list_windows', { filter: '' }).catch(() => null);
      const still = wins ? toArray(wins.windows).some((w) => w.handle === result.window?.handle) : false;
      add('window_present', Boolean(result.window_found && (still || result.window?.handle)), {
        window_found: result.window_found, window: result.window ? { title: result.window.title, handle: result.window.handle, process: result.window.process } : null,
        rechecked: Boolean(wins),
      });
      success = Boolean(result.launched && result.window_found);
      confidence = success ? 0.95 : 0.2;
      next = success ? null : 'Inspect the process/window list; the application may have failed to start or opened without a visible window.';
      break;
    }
    case 'computer.focus_window': {
      add('foreground_is_target', Boolean(result.focus_ok), { foreground: result.foreground_after, target: result.handle });
      success = Boolean(result.focus_ok);
      confidence = success ? 0.98 : 0.1;
      next = success ? null : 'Another window may be modal or the target may be minimized; inspect the window list.';
      break;
    }
    case 'computer.click':
    case 'computer.double_click':
    case 'computer.right_click': {
      const uiChanged = change?.changed ?? false;
      add('ui_changed', uiChanged, change ? { ahash_distance: change.ahash_distance, score: change.change_score } : null, 1);
      add('window_changed', windowChanged, { before: before?.window?.title, after: after?.window?.title }, 0.5);
      if (uiChanged || windowChanged) {
        success = true;
        confidence = result.method?.startsWith('coordinate') ? 0.6 : 0.7;
        next = null;
      } else {
        success = null;
        confidence = 0.3;
        next = 'No observable change. Inspect the UI tree/dialog state before clicking again; the click may have missed or produced no visible effect.';
      }
      break;
    }
    case 'computer.type_text': {
      const expected = String(args.text ?? '');
      let actual = null;
      let method = null;
      if (args.element_id && ctx.resolveElementAfter) {
        const relooked = await ctx.resolveElementAfter(args.element_id).catch(() => null);
        if (relooked) {
          const textRes = await ctx.perception.elementText(relooked.id, { allowClipboard: true }).catch(() => null);
          if (textRes) { actual = textRes.text; method = textRes.method; }
        }
      }
      if (actual !== null) {
        const ok = normalize(actual).includes(normalize(expected).slice(0, 120));
        add('element_text_contains_expected', ok, { method, expected_sample: expected.slice(0, 80), actual_sample: String(actual).slice(0, 160) });
        success = ok;
        confidence = method === 'ValuePattern' ? 0.95 : method === 'clipboard' ? 0.9 : 0.75;
      } else {
        const ocr = after?.ocr?.text ?? (await ctx.perception.readVisibleText({ region: after?.window?.bounds }).catch(() => null))?.text ?? '';
        const ok = expected.trim().length > 0 && normalize(ocr).includes(normalize(expected).slice(0, 60));
        add('ocr_contains_expected', ok, { expected_sample: expected.slice(0, 80), ocr_sample: ocr.slice(0, 200) });
        success = ok ? true : null;
        confidence = ok ? 0.65 : 0.25;
      }
      if (success !== true) next = 'Read the target field (UIA Value/TextPattern or clipboard) and compare it to the requested text before retyping.';
      break;
    }
    case 'computer.press_key':
    case 'computer.hotkey': {
      add('ui_changed', change?.changed ?? false, change ? { ahash_distance: change.ahash_distance } : null);
      add('window_changed', windowChanged, { before: before?.window?.title, after: after?.window?.title }, 0.5);
      if (change?.changed || windowChanged) { success = true; confidence = 0.55; }
      else { success = null; confidence = 0.2; next = 'The key may have had no visible effect; inspect the focused control before repeating.'; }
      break;
    }
    case 'computer.scroll':
    case 'computer.drag': {
      add('ui_changed', change?.changed ?? false, change ? { ahash_distance: change.ahash_distance } : null);
      success = change?.changed ? true : null;
      confidence = change?.changed ? 0.6 : 0.2;
      break;
    }
    case 'filesystem.write_text': {
      const read = readFileSync(result.path);
      const sha = createHash('sha256').update(read).digest('hex');
      const content = read.toString('utf8');
      add('file_exists', statSync(result.path).isFile(), { path: result.path, bytes: read.length });
      add('sha256_matches', sha === result.sha256, { expected: result.sha256, actual: sha });
      add('content_matches', content.includes(String(args.text ?? '').slice(0, 200)), { expected_sample: String(args.text ?? '').slice(0, 80) });
      success = checks.every((c) => c.passed);
      confidence = success ? 0.99 : 0.05;
      break;
    }
    case 'filesystem.delete': {
      add('target_gone', result.still_exists === false, { path: result.path });
      success = result.still_exists === false;
      confidence = success ? 0.99 : 0.2;
      break;
    }
    case 'system.run_command': {
      add('exit_code_zero', result.exit_code === 0, { exit_code: result.exit_code, timed_out: result.timed_out });
      add('stderr_empty', !result.stderr || String(result.stderr).trim().length === 0, { stderr_sample: String(result.stderr ?? '').slice(0, 300) }, 0.5);
      success = result.exit_code === 0;
      confidence = success ? 0.95 : 0.9;
      next = success ? null : 'Read stderr and the exit code; fix the command or environment before retrying.';
      break;
    }
    case 'browser.navigate': {
      const page = await ctx.browser.evaluate('({url: location.href, state: document.readyState})').catch(() => null);
      const expected = String(args.url);
      const ok = page && normalize(page.url).startsWith(normalize(expected).split('#')[0]);
      add('destination_reached', Boolean(ok), { expected, actual: page?.url, ready_state: page?.state });
      success = Boolean(ok);
      confidence = ok ? 0.95 : 0.2;
      break;
    }
    case 'browser.fill': {
      const value = await ctx.browser.evaluate(`(() => {
        const el = ${args.selector ? `document.querySelector(${JSON.stringify(args.selector)})` : 'document.activeElement'};
        return el ? el.value ?? el.innerText ?? null : null;
      })()`).catch(() => null);
      const ok = value !== null && normalize(String(value)).includes(normalize(String(args.text)).slice(0, 120));
      add('field_value_matches', ok, { expected_sample: String(args.text).slice(0, 80), actual_sample: String(value ?? '').slice(0, 120) });
      success = ok;
      confidence = ok ? 0.9 : 0.2;
      break;
    }
    case 'browser.click': {
      const page = await ctx.browser.inspect({ maxElements: 20 }).catch(() => null);
      add('page_available', Boolean(page), { url: page?.url, title: page?.title });
      success = page ? true : null;
      confidence = page ? 0.6 : 0.2;
      next = 'Confirm the expected navigation or DOM state with browser.inspect.';
      break;
    }
    default:
      success = null;
      confidence = 0;
      next = 'No verification rule exists for this tool; treat the outcome as unverified.';
  }

  const weightSum = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const passedWeight = checks.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);

  return {
    action: tool,
    expected: args?.expected_result ?? null,
    success,
    status: success === true ? 'VERIFIED' : success === false ? 'FAILED' : 'UNVERIFIED',
    confidence: Number((success === true ? Math.max(confidence, passedWeight / weightSum) : confidence).toFixed(2)),
    checks,
    evidence: {
      before_screenshot: beforeShot?.ref ?? null,
      after_screenshot: afterShot?.ref ?? null,
      before_window: before?.window ? { title: before.window.title, handle: before.window.handle } : null,
      after_window: after?.window ? { title: after.window.title, handle: after.window.handle } : null,
      change: change ? { changed: change.changed, score: change.change_score, distance: change.ahash_distance } : null,
    },
    recommended_next_step: next,
  };
}

function toArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
function normalize(s) { return String(s).replace(/\s+/g, ' ').trim().toLowerCase(); }
