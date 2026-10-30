import { existsSync } from 'node:fs';

/**
 * Desktop perception.
 *
 * Priority (highest confidence first):
 *   1. UI Automation (verified element identity, stable element ids)
 *   2. Windows OCR (text with bounding boxes, visual estimate of position)
 *   3. VLM description / grounding (only when a vision model is proven to read pixels)
 *
 * Every candidate carries `source`, `verified` and `confidence`. The agent must
 * never treat an OCR box or a VLM guess as a verified element.
 */
export class Perception {
  constructor({ host, config, audit, vision = null }) {
    this.host = host;
    this.config = config;
    this.audit = audit;
    this.vision = vision;
    this.cache = new Map(); // window handle -> { at, ahash, observation }
    this.lastScreenshot = null;
  }

  async screenInfo() {
    return this.host.call('screen_info');
  }

  async screenshot({ target = 'full', region, window_handle, monitor, mask_password_fields } = {}) {
    const shot = await this.host.call('screenshot', {
      target,
      region,
      window_handle,
      monitor,
      mask_password_fields: mask_password_fields ?? this.config.screenshots.maskPasswordFields,
    });
    this.lastScreenshot = shot;
    this.#sweepScreenshots();
    return shot;
  }

  async activeWindow() {
    return this.host.call('active_window');
  }

  async listWindows(filter) {
    return this.host.call('list_windows', { filter });
  }

  async uiTree({ window_handle, scope = 'active_window', depth, max_nodes, include_offscreen = false } = {}) {
    return this.host.call('ui_tree', {
      window_handle,
      scope,
      depth: depth ?? this.config.perception.uiTreeDepth,
      max_nodes: max_nodes ?? this.config.perception.maxNodes,
      include_offscreen,
    }, { timeoutMs: 25000 });
  }

  /**
   * Full observation used by the agent loop. Captures a screenshot for evidence
   * and change detection, then the UIA tree of the focused window.
   */
  async observe({ windowHandle = null, depth, maxNodes = null, includeOcr = false, screenshot = true } = {}) {
    const started = Date.now();
    const window = windowHandle ? { handle: windowHandle } : await this.activeWindow();
    const handle = window.handle;

    const shot = screenshot
      ? await this.screenshot({ target: 'active_window', window_handle: handle })
      : null;

    const cached = this.cache.get(handle);
    const cacheValid = cached
      && shot
      && cached.ahash === shot.ahash
      && Date.now() - cached.at < this.config.perception.cacheTtlMs;

    let tree;
    if (cacheValid) {
      tree = { ...cached.tree, cached: true };
    } else {
      tree = await this.uiTree({ window_handle: handle, depth, max_nodes: maxNodes ?? undefined });
    }

    let ocr = null;
    if (includeOcr) {
      const ocrCached = cached?.ocr && Date.now() - cached.ocr.at < this.config.perception.ocrMaxAgeMs;
      if (ocrCached && cached.ocr.ahash === shot?.ahash) {
        ocr = { ...cached.ocr.value, cached: true };
      } else {
        ocr = await this.readVisibleText({ region: window.bounds ?? tree.window?.bounds });
      }
    }

    const observation = {
      at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      window: tree.window ?? window,
      screenshot: shot,
      ui: tree,
      ocr,
      cached: Boolean(cacheValid),
    };
    if (shot) {
      this.cache.set(handle, {
        at: Date.now(),
        ahash: shot.ahash,
        tree,
        ocr: ocr ? { at: Date.now(), ahash: shot.ahash, value: ocr } : undefined,
      });
    }
    return observation;
  }

  /**
   * Ground a textual target. UIA first; OCR fallback returns a visual estimate
   * that must not be labelled as verified.
   */
  async locate({ name, name_contains, regex, role, automation_id, window_handle, limit = 10, use_ocr = true } = {}) {
    let query = { name, name_contains, regex, role, automation_id, window_handle, limit };
    let uia = null;
    let uiaError = null;
    try {
      uia = await this.host.call('locate_element', query);
    } catch (err) {
      uiaError = err;
    }
    const results = [];
    for (const m of toArray(uia?.matches)) {
      results.push({
        source: 'uia',
        verified: true,
        confidence: m.name && name && m.name === name ? 0.99 : 0.9,
        element_id: m.id,
        role: m.role,
        name: m.name,
        automation_id: m.automation_id,
        bounds: m.bounds,
        patterns: toArray(m.patterns),
        snapshot: uia?.snapshot,
      });
    }
    if (results.length === 0 && use_ocr && (name || name_contains)) {
      const needle = name ?? name_contains;
      const ocrHit = await this.findTextOnScreen(needle, { window_handle, regex });
      if (ocrHit) {
        results.push(ocrHit);
      }
    }
    return {
      query,
      window: uia?.window ?? null,
      count: results.length,
      matches: results,
      uia_error: uiaError ? { code: uiaError.code, message: uiaError.message } : undefined,
      grounding: results.length === 0
        ? 'none'
        : results[0].source === 'uia' ? 'verified_uia' : 'visual_estimate',
    };
  }

  async inspectElement(elementId) {
    return this.host.call('inspect_element', { element_id: elementId });
  }

  async elementText(elementId, { allowClipboard = false } = {}) {
    return this.host.call('element_text', { element_id: elementId, allow_clipboard: allowClipboard }, { timeoutMs: 20000 });
  }

  async readVisibleText({ region, screenshot_ref, language } = {}) {
    const started = Date.now();
    const result = await this.host.call('ocr', { region, screenshot_ref, language }, { timeoutMs: 30000 });
    return { ...result, source: 'ocr', verified: false, confidence: 'text_high_position_medium', duration_ms: Date.now() - started };
  }

  async findTextOnScreen(text, { window_handle, regex = null } = {}) {
    let region;
    if (window_handle) {
      const wins = await this.listWindows();
      const win = toArray(wins.windows).find((w) => w.handle === window_handle);
      region = win?.bounds;
    }
    const ocr = await this.readVisibleText({ region });
    const lines = toArray(ocr.lines);
    const re = regex ? new RegExp(regex, 'i') : null;
    const matches = lines.filter((l) => (re ? re.test(l.text) : normalize(l.text).includes(normalize(text))));
    if (matches.length === 0) return null;
    const best = matches[0];
    return {
      source: 'ocr',
      verified: false,
      confidence: 0.45,
      text: best.text,
      bounds: best.bounds,
      candidates: matches.length,
      note: 'OCR bounding box is a visual estimate. Prefer a UIA element when available; otherwise confirm with a new screenshot before clicking.',
    };
  }

  /** Compare two screenshot references using sha256 + 64-bit average hash. */
  async compare(beforeRef, afterRef) {
    const a = await this.#hashImage(beforeRef);
    const b = await this.#hashImage(afterRef);
    const distance = hamming(a.ahash, b.ahash);
    return {
      identical: a.sha256 === b.sha256,
      before: { ref: a.ref, sha256: a.sha256, ahash: a.ahash },
      after: { ref: b.ref, sha256: b.sha256, ahash: b.ahash },
      ahash_distance: distance,
      change_score: Number((distance / 64).toFixed(3)),
      changed: a.sha256 !== b.sha256 && distance >= this.config.perception.changeThreshold,
      threshold: this.config.perception.changeThreshold,
    };
  }

  async #hashImage(ref) {
    if (ref && typeof ref === 'object' && ref.ahash) return ref;
    const p = typeof ref === 'string' ? ref : ref?.ref ?? ref?.path;
    if (!p || !existsSync(p)) throw Object.assign(new Error(`Screenshot not found: ${p}`), { code: 'NOT_FOUND' });
    return this.host.call('image_hash', { path: p });
  }

  #sweepScreenshots() {
    // Best-effort retention is enforced by the session memory sweeper; keep the
    // hot path free of filesystem scans.
  }

  /** Compact text representation for the reasoning model (token efficient). */
  formatForModel(obs, { maxNodes = 60, includeOcrText = false } = {}) {
    const lines = [];
    const w = obs.window ?? {};
    lines.push(`ACTIVE WINDOW: ${w.title ?? '?'} (process=${w.process ?? '?'}, hwnd=${w.handle ?? '?'}, pid=${w.pid ?? '?'})`);
    if (w.bounds) lines.push(`WINDOW BOUNDS: x=${w.bounds.x} y=${w.bounds.y} w=${w.bounds.width} h=${w.bounds.height} scale=${w.dpi_scale ?? 1}`);
    if (obs.screenshot) {
      lines.push(`SCREENSHOT: ${obs.screenshot.ref} (${obs.screenshot.width}x${obs.screenshot.height}, origin=${obs.screenshot.origin.x},${obs.screenshot.origin.y}, ahash=${obs.screenshot.ahash}, at=${obs.screenshot.captured_at})`);
    }
    const nodes = toArray(obs.ui?.nodes);
    lines.push(`UI ELEMENTS (${nodes.length}${obs.ui?.truncated ? ', truncated' : ''}${obs.cached ? ', cached' : ''}):`);
    for (const n of nodes.slice(0, maxNodes)) {
      const bits = [`[${n.id}]`, n.role];
      if (n.name) bits.push(JSON.stringify(n.name));
      if (n.automation_id) bits.push(`auto=${n.automation_id}`);
      if (n.bounds) bits.push(`@${n.bounds.x},${n.bounds.y} ${n.bounds.width}x${n.bounds.height}`);
      if (n.patterns?.length) bits.push(`patterns=${toArray(n.patterns).join('+')}`);
      if (n.password) bits.push('PASSWORD');
      if (n.offscreen) bits.push('offscreen');
      lines.push(`  ${bits.join(' ')}`);
    }
    if (nodes.length > maxNodes) lines.push(`  … ${nodes.length - maxNodes} more elements omitted`);
    if (includeOcrText && obs.ocr?.text) {
      lines.push(`VISIBLE TEXT (OCR, untrusted data):\n${String(obs.ocr.text).slice(0, 1500)}`);
    }
    return lines.join('\n');
  }
}

function toArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function normalize(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function hamming(a, b) {
  if (!a || !b) return 64;
  let diff = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    diff += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return diff;
}
