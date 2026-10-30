import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Minimal OpenAI-compatible chat client. Works with llama.cpp/textgen,
 * Ollama's /v1 endpoint, LM Studio and vLLM.
 */
export class OpenAIClient {
  constructor({ baseUrl, model, apiKey = null, timeoutMs = 180000, temperature = 0.1, maxOutputTokens = 900, audit = null, label = 'primary' }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.temperature = temperature;
    this.maxOutputTokens = maxOutputTokens;
    this.audit = audit;
    this.label = label;
    this.lastUsage = null;
  }

  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async #request(pathname, { method = 'GET', body, timeoutMs } = {}) {
    const res = await fetch(this.baseUrl + pathname, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) {
      const detail = json?.error?.message ?? json?.message ?? text.slice(0, 500);
      throw Object.assign(new Error(`Model endpoint ${res.status} at ${pathname}: ${detail}`), { code: 'MODEL_HTTP_ERROR', status: res.status, body: text.slice(0, 2000) });
    }
    return json;
  }

  async listModels() {
    const data = await this.#request('/models', { timeoutMs: 8000 });
    return (data?.data ?? []).map((m) => ({ id: m.id, owned_by: m.owned_by ?? null, created: m.created ?? null }));
  }

  /** Non-streaming chat completion with retry on transient failures. */
  async chat({ messages, tools, responseFormat, maxTokens, temperature, timeoutMs, retries = 1 }) {
    const body = {
      model: this.model,
      messages,
      temperature: temperature ?? this.temperature,
      max_tokens: maxTokens ?? this.maxOutputTokens,
      stream: false,
    };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    if (responseFormat) body.response_format = responseFormat;
    const started = Date.now();
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const json = await this.#request('/chat/completions', { method: 'POST', body, timeoutMs });
        const choice = json?.choices?.[0];
        if (!choice) throw Object.assign(new Error('Model returned no choices'), { code: 'MODEL_EMPTY_RESPONSE' });
        const content = choice.message?.content ?? '';
        const result = {
          content: typeof content === 'string' ? content : JSON.stringify(content),
          tool_calls: choice.message?.tool_calls ?? [],
          finish_reason: choice.finish_reason ?? null,
          usage: json.usage ?? null,
          model: json.model ?? this.model,
          latency_ms: Date.now() - started,
          raw_id: json.id ?? null,
        };
        this.lastUsage = result.usage;
        this.audit?.info('model.chat', {
          label: this.label, model: result.model, latency_ms: result.latency_ms,
          prompt_tokens: result.usage?.prompt_tokens, completion_tokens: result.usage?.completion_tokens,
          finish_reason: result.finish_reason, chars: result.content.length,
          tool_calls: result.tool_calls.length,
        });
        return result;
      } catch (err) {
        lastError = err;
        this.audit?.warn('model.chat_error', { label: this.label, attempt, error: err.message, status: err.status });
        if (err.code === 'MODEL_HTTP_ERROR' && err.status && err.status < 500 && err.status !== 429) break;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  /**
   * Empirical capability probe. Assumes nothing: each capability is only
   * reported true when a controlled request proves it.
   */
  async probeCapabilities({ includeVision = true } = {}) {
    const report = {
      base_url: this.baseUrl,
      model: this.model,
      probed_at: new Date().toISOString(),
      text: { supported: false },
      tools: { supported: false, evidence: null },
      json_schema: { supported: false, evidence: null },
      arabic: { supported: false, evidence: null },
      vision: { supported: false, verified: false, reason: 'not probed', evidence: null },
      context: { reported: null },
    };

    // 1. Basic text
    try {
      const basic = await this.chat({
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 8,
        temperature: 0,
        timeoutMs: 60000,
      });
      report.text = { supported: /OK/i.test(basic.content), latency_ms: basic.latency_ms, sample: basic.content.slice(0, 80) };
    } catch (err) {
      report.text = { supported: false, error: err.message };
      return report;
    }

    // 2. Native tool calling
    try {
      const tool = {
        type: 'function',
        function: {
          name: 'open_application',
          description: 'Open a Windows application by name.',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      };
      const res = await this.chat({
        messages: [
          { role: 'system', content: 'You are a Windows automation agent. Call a tool when the user asks for an action.' },
          { role: 'user', content: 'Open Notepad.' },
        ],
        tools: [tool],
        maxTokens: 120,
        temperature: 0,
        timeoutMs: 90000,
      });
      const call = res.tool_calls?.[0];
      const valid = Boolean(call?.function?.name === 'open_application' && /notepad/i.test(call?.function?.arguments ?? ''));
      report.tools = {
        supported: valid,
        evidence: { tool_calls: res.tool_calls?.length ?? 0, name: call?.function?.name ?? null, arguments: call?.function?.arguments ?? null, latency_ms: res.latency_ms },
        note: valid ? 'Native OpenAI-style tool calls work.' : 'No valid tool call returned; use the JSON action protocol.',
      };
    } catch (err) {
      report.tools = { supported: false, error: err.message, note: 'Tool calling request failed; use the JSON action protocol.' };
    }

    // 3. JSON schema response format
    try {
      const res = await this.chat({
        messages: [
          { role: 'system', content: 'Return one JSON object only, no markdown.' },
          { role: 'user', content: 'Classify the risk of clicking a Save button. Return {"risk":"low|medium|high","reason":"..."}' },
        ],
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'risk',
            strict: true,
            schema: {
              type: 'object',
              properties: { risk: { type: 'string', enum: ['low', 'medium', 'high'] }, reason: { type: 'string' } },
              required: ['risk', 'reason'],
              additionalProperties: false,
            },
          },
        },
        maxTokens: 150,
        temperature: 0,
        timeoutMs: 90000,
      });
      let parsed = null;
      try { parsed = JSON.parse(res.content); } catch { /* invalid */ }
      report.json_schema = {
        supported: Boolean(parsed && ['low', 'medium', 'high'].includes(parsed.risk)),
        evidence: { content: res.content.slice(0, 200), latency_ms: res.latency_ms },
      };
    } catch (err) {
      report.json_schema = { supported: false, error: err.message, note: 'Fall back to tolerant JSON extraction + schema validation.' };
    }

    // 4. Arabic
    try {
      const target = 'أهلاً بك في نظام Computer Use';
      const res = await this.chat({
        messages: [
          { role: 'system', content: 'Repeat the user text exactly, with no extra words.' },
          { role: 'user', content: target },
        ],
        maxTokens: 60,
        temperature: 0,
        timeoutMs: 60000,
      });
      const strip = (s) => s.replace(/[\u064B-\u0652]/g, '').replace(/[أإآ]/g, 'ا').replace(/\s+/g, ' ').trim();
      report.arabic = {
        supported: strip(res.content).includes(strip(target)),
        evidence: { output: res.content.slice(0, 120), exact: res.content.trim() === target },
        note: 'Exact typing is performed by SendInput, not by the model; this only measures the model’s Arabic understanding.',
      };
    } catch (err) {
      report.arabic = { supported: false, error: err.message };
    }

    // 5. Vision — the critical test. Text-only servers silently drop image parts.
    if (includeVision) {
      report.vision = await this.#probeVision();
    }
    return report;
  }

  async #probeVision() {
    const redPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const greenPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const textOnly = 'What is the dominant color? Answer with one word (red, green, blue, black or white).';
    try {
      const baseline = await this.chat({
        messages: [{ role: 'user', content: textOnly }],
        maxTokens: 6,
        temperature: 0,
        timeoutMs: 60000,
      });
      const withRed = await this.chat({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: textOnly },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${redPng}` } },
          ],
        }],
        maxTokens: 6,
        temperature: 0,
        timeoutMs: 90000,
      });
      const withGreen = await this.chat({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: textOnly },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${greenPng}` } },
          ],
        }],
        maxTokens: 6,
        temperature: 0,
        timeoutMs: 90000,
      });
      const baseTokens = baseline.usage?.prompt_tokens ?? 0;
      const redTokens = withRed.usage?.prompt_tokens ?? 0;
      const greenTokens = withGreen.usage?.prompt_tokens ?? 0;
      const tokenDelta = Math.min(redTokens, greenTokens) - baseTokens;
      const redSaysRed = /\bred\b/i.test(withRed.content);
      const greenSaysGreen = /\bgreen\b/i.test(withGreen.content);
      const imageProcessed = tokenDelta >= 50;
      const verified = imageProcessed && redSaysRed && greenSaysGreen;
      let reason;
      if (!imageProcessed) {
        reason = `The server accepted image parts but did not tokenize them (prompt tokens ${baseTokens} -> ${redTokens}; delta ${tokenDelta}). The model is text-only and silently ignored the image.`;
      } else if (!verified) {
        reason = `Images are tokenized (delta ${tokenDelta}) but the answers were wrong (red -> "${withRed.content.trim()}", green -> "${withGreen.content.trim()}"). Visual perception is unreliable.`;
      } else {
        reason = `Images are tokenized (delta ${tokenDelta}) and both solid-color probes were answered correctly.`;
      }
      return {
        supported: imageProcessed,
        verified,
        reason,
        evidence: {
          baseline_tokens: baseTokens,
          red_tokens: redTokens,
          green_tokens: greenTokens,
          token_delta: tokenDelta,
          red_answer: withRed.content.trim().slice(0, 40),
          green_answer: withGreen.content.trim().slice(0, 40),
        },
      };
    } catch (err) {
      return { supported: false, verified: false, reason: `Vision probe failed: ${err.message}`, evidence: null };
    }
  }

  /** Public wrapper for the strict pixel-level vision probe. */
  async probeVision() {
    return this.#probeVision();
  }

  /** Ask an Ollama server to unload a model to free VRAM. */
  async unloadIfOllama() {
    if (!this.baseUrl.includes('11434') && !this.baseUrl.includes('/ollama')) return { skipped: true };
    try {
      const res = await fetch(this.baseUrl.replace(/\/v1$/, '') + '/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, keep_alive: 0 }),
        signal: AbortSignal.timeout(10000),
      });
      return { requested: true, status: res.status };
    } catch (err) {
      return { requested: false, error: err.message };
    }
  }
}

export function imageDataUrl(filePath) {
  const buf = readFileSync(filePath);
  const ext = basename(filePath).toLowerCase().endsWith('.jpg') || basename(filePath).toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}
