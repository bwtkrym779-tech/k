import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ToolError } from '../core/errors.mjs';
import { imageDataUrl } from '../model/client.mjs';

/**
 * Vision adapter. It is only "available" when a verification artifact proves
 * that the configured model actually processed image pixels. This prevents the
 * classic failure mode where a text-only endpoint returns HTTP 200 while
 * silently discarding the image and the agent hallucinates visual grounding.
 */
export class VisionAdapter {
  constructor({ client, config, audit, verificationFile }) {
    this.client = client;
    this.config = config;
    this.audit = audit;
    this.verificationFile = verificationFile ?? path.join(config.stateDir, 'vision-verification.json');
    this.verification = this.#loadVerification();
  }

  #loadVerification() {
    if (!existsSync(this.verificationFile)) return null;
    try { return JSON.parse(readFileSync(this.verificationFile, 'utf8')); } catch { return null; }
  }

  matchesConfiguredModel() {
    return Boolean(
      this.verification
      && this.verification.verified === true
      && this.verification.model === this.config.vision.model
      && this.verification.base_url === this.config.vision.baseUrl,
    );
  }

  status() {
    if (!this.config.vision.enabled) {
      return {
        available: false, configured: false, verified: false,
        reason: 'Vision is disabled in .agent/config.json (vision.enabled=false).',
        probe: this.verification,
      };
    }
    if (!this.matchesConfiguredModel()) {
      return {
        available: false, configured: true, verified: false,
        reason: this.verification
          ? `Verification artifact is missing, stale, or for a different model (expected ${this.config.vision.model} at ${this.config.vision.baseUrl}).`
          : 'No verification artifact. Run: node scripts/verify_vision.mjs',
        probe: this.verification,
      };
    }
    return {
      available: true, configured: true, verified: true,
      model: this.config.vision.model,
      reason: 'Image processing was empirically verified on a controlled color probe.',
      probe: this.verification,
    };
  }

  async describe({ screenshot_ref, question = 'Describe the application state, visible dialogs and errors.', max_tokens = 300 }) {
    const status = this.status();
    if (!status.available) throw new ToolError('VISION_UNAVAILABLE', status.reason);
    const file = path.resolve(this.config.root, screenshot_ref);
    if (!existsSync(file)) throw new ToolError('NOT_FOUND', `Screenshot not found: ${file}`);
    const started = Date.now();
    const res = await this.client.chat({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${question}\nAnswer in at most 120 words. Describe only what is visible. Do not invent element coordinates.` },
          { type: 'image_url', image_url: { url: imageDataUrl(file) } },
        ],
      }],
      maxTokens: max_tokens,
      temperature: 0.1,
      timeoutMs: 120000,
    });
    return {
      available: true,
      model: this.config.vision.model,
      text: res.content.trim(),
      confidence: 'description_only',
      latency_ms: Date.now() - started,
      usage: res.usage,
      note: 'VLM description is not a verified element identity and must not be used as pixel coordinates.',
    };
  }

  async locate() {
    throw new ToolError(
      'GROUNDING_UNAVAILABLE',
      'No verified GUI-grounding model is configured. VLM captions do not provide reliable element coordinates. Use computer.locate_element (UIA/OCR) instead.',
    );
  }
}
