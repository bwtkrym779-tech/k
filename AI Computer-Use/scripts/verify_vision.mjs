#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/core/config.mjs';
import { OpenAIClient } from '../src/model/client.mjs';

/**
 * Empirically prove (or disprove) that a model reads image pixels.
 *
 * A text-only llama.cpp server accepts OpenAI image parts and returns HTTP 200
 * while dropping the image. We therefore measure the prompt-token delta and
 * require two different solid-color images to produce the right answers.
 * Only a passing probe writes .agent/vision-verification.json.
 */
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const config = loadConfig(process.cwd());
const baseUrl = flag('base-url', config.vision.baseUrl ?? config.endpoint.baseUrl);
const model = flag('model', config.vision.model);
const apiKey = flag('api-key', config.vision.apiKey ?? config.endpoint.apiKey);
const json = argv.includes('--json');

if (!model) {
  console.error('A vision model name is required: --model <name> (or set vision.model in .agent/config.json)');
  process.exit(2);
}

console.log(`Probing vision support: ${model} @ ${baseUrl}`);
console.log('This sends two tiny synthetic images and measures prompt tokens; no screenshot leaves this machine.');

const client = new OpenAIClient({ baseUrl, model, apiKey, timeoutMs: 120000, label: 'vision-probe' });
const result = await client.probeVision();

const artifact = {
  verified: result.verified === true,
  model,
  base_url: baseUrl.replace(/\/$/, ''),
  probed_at: new Date().toISOString(),
  reason: result.reason,
  evidence: result.evidence,
  probe: 'solid-color 1x1 red/green + prompt-token delta (>=50 tokens required)',
};

if (json) {
  console.log(JSON.stringify(artifact, null, 2));
} else {
  console.log('');
  console.log(`supported (images tokenized): ${result.supported}`);
  console.log(`verified (answers correct):   ${result.verified}`);
  console.log(`reason: ${result.reason}`);
  if (result.evidence) {
    console.log(`tokens: baseline=${result.evidence.baseline_tokens} red=${result.evidence.red_tokens} green=${result.evidence.green_tokens} delta=${result.evidence.token_delta}`);
    console.log(`answers: red->"${result.evidence.red_answer}" green->"${result.evidence.green_answer}"`);
  }
}

if (!result.verified) {
  console.log('');
  console.log('NOT VERIFIED. Do not enable vision; the agent will keep using UIA + OCR.');
  process.exit(1);
}

mkdirSync(config.stateDir, { recursive: true });
const target = path.join(config.stateDir, 'vision-verification.json');
writeFileSync(target, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
console.log('');
console.log(`Wrote ${target}`);
console.log('Enable it explicitly in .agent/config.json:');
console.log(JSON.stringify({ vision: { enabled: true, baseUrl: artifact.base_url, model } }, null, 2));
