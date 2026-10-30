import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAIClient } from './client.mjs';

/** Known local OpenAI-compatible runtimes and their default ports. */
export const KNOWN_RUNTIMES = [
  { id: 'ollama', name: 'Ollama', port: 11434, native: '/api/tags', openai: '/v1', modelsPath: path.join(os.homedir(), '.ollama', 'models') },
  { id: 'lmstudio', name: 'LM Studio', port: 1234, native: '/v1/models', openai: '/v1', modelsPath: path.join(os.homedir(), '.cache', 'lm-studio', 'models') },
  { id: 'textgen', name: 'textgen (llama.cpp)', port: 5000, native: '/v1/models', openai: '/v1', modelsPath: null },
  { id: 'vllm', name: 'vLLM', port: 8000, native: '/v1/models', openai: '/v1', modelsPath: null },
  { id: 'llamacpp', name: 'llama.cpp server', port: 8080, native: '/v1/models', openai: '/v1', modelsPath: null },
];

export async function probeRuntime(runtime, timeoutMs = 2500) {
  const base = `http://127.0.0.1:${runtime.port}`;
  try {
    const res = await fetch(base + runtime.native, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ...runtime, reachable: false, status: res.status };
    const json = await res.json();
    let models = [];
    if (runtime.id === 'ollama') {
      models = (json.models ?? []).map((m) => ({
        id: m.name, size_bytes: m.size ?? null, family: m.details?.family ?? null,
        parameters: m.details?.parameter_size ?? null, quantization: m.details?.quantization_level ?? null,
        modified_at: m.modified_at ?? null,
      }));
    } else {
      models = (json.data ?? []).map((m) => ({ id: m.id, owned_by: m.owned_by ?? null }));
    }
    return { ...runtime, reachable: true, base_url: base, models };
  } catch (err) {
    return { ...runtime, reachable: false, error: err.message };
  }
}

export async function detectRuntimes() {
  const results = await Promise.all(KNOWN_RUNTIMES.map((r) => probeRuntime(r)));
  return results;
}

export function hardwareInfo() {
  const cpus = os.cpus();
  const memTotal = os.totalmem();
  const info = {
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), version: os.version() },
    cpu: { model: cpus[0]?.model?.trim(), cores: cpus.length, speed_mhz: cpus[0]?.speed },
    memory: { total_gb: round(memTotal / 1e9), free_gb: round(os.freemem() / 1e9) },
    node: process.version,
    gpu: null,
  };
  try {
    const out = execFileSync('nvidia-smi', [
      '--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
    info.gpu = out.split(/\r?\n/).map((line) => {
      const [name, driver, total, used, free, util, temp] = line.split(',').map((s) => s.trim());
      return {
        name, driver, vram_total_mb: Number(total), vram_used_mb: Number(used), vram_free_mb: Number(free),
        utilization_pct: Number(util), temperature_c: Number(temp),
      };
    });
  } catch (err) {
    info.gpu = { error: err.message };
  }
  return info;
}

export function findLocalModelFiles(hintDirs = []) {
  const dirs = new Set(hintDirs.filter(Boolean));
  const textgen = path.join(os.homedir(), 'Downloads', 'textgen-4.9', 'user_data', 'models');
  if (existsSync(textgen)) dirs.add(textgen);
  const found = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.gguf')) continue;
      const full = path.join(dir, name);
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      found.push({ path: full, name, size_bytes: size, size_gb: round(size / 1e9 / 1.0, 2), metadata: readGgufMetadata(full) });
    }
  }
  return found;
}

/** Read the GGUF metadata header (no tensor data) to learn the real model identity. */
export function readGgufMetadata(file) {
  try {
    const fd = openSync(file, 'r');
    const size = statSync(file).size;
    const chunk = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
    readSync(fd, chunk, 0, chunk.length, 0);
    closeSync(fd);
    let off = 0;
    const u32 = () => { const v = chunk.readUInt32LE(off); off += 4; return v; };
    const u64 = () => { const v = Number(chunk.readBigUInt64LE(off)); off += 8; return v; };
    const str = () => { const n = u64(); const s = chunk.subarray(off, off + n).toString('utf8'); off += n; return s; };
    if (chunk.subarray(0, 4).toString('ascii') !== 'GGUF') return null;
    off = 4;
    const version = u32();
    u64(); // tensor count
    const kvCount = u64();
    const scalar = (type) => {
      switch (type) {
        case 0: return chunk.readUInt8(off++);
        case 1: return chunk.readInt8(off++);
        case 2: { const v = chunk.readUInt16LE(off); off += 2; return v; }
        case 3: { const v = chunk.readInt16LE(off); off += 2; return v; }
        case 4: return u32();
        case 5: { const v = chunk.readInt32LE(off); off += 4; return v; }
        case 6: { const v = chunk.readFloatLE(off); off += 4; return v; }
        case 7: return chunk.readUInt8(off++) !== 0;
        case 8: return str();
        case 10: return u64();
        case 11: { const v = Number(chunk.readBigInt64LE(off)); off += 8; return v; }
        case 12: { const v = chunk.readDoubleLE(off); off += 8; return v; }
        default: throw new Error(`unknown gguf type ${type}`);
      }
    };
    const meta = {};
    for (let i = 0; i < kvCount; i++) {
      const key = str();
      const type = u32();
      if (type === 9) {
        const arrType = u32();
        const n = u64();
        const arr = [];
        for (let j = 0; j < n; j++) arr.push(arrType === 8 ? str() : scalar(arrType));
        meta[key] = arr;
      } else {
        meta[key] = scalar(type);
      }
    }
    const arch = meta['general.architecture'];
    return {
      version,
      architecture: arch,
      name: meta['general.name'] ?? null,
      context_length: meta[`${arch}.context_length`] ?? null,
      embedding_length: meta[`${arch}.embedding_length`] ?? null,
      block_count: meta[`${arch}.block_count`] ?? null,
      head_count: meta[`${arch}.attention.head_count`] ?? null,
      head_count_kv: meta[`${arch}.attention.head_count_kv`] ?? null,
      file_type: meta['general.file_type'] ?? null,
      has_chat_template: Boolean(meta['tokenizer.chat_template']),
      has_tool_template: typeof meta['tokenizer.chat_template'] === 'string' && /tool/i.test(meta['tokenizer.chat_template']),
    };
  } catch {
    return null;
  }
}

/**
 * Estimate GPU KV-cache cost per token for llama.cpp-style models.
 * Used to explain why a 6GB card needs a small context.
 */
export function estimateKvCache({ layers, heads, headDim = 128, kvHeads = null, bytesPerElement = 1 }) {
  const kv = kvHeads ?? heads;
  const perToken = 2 * layers * kv * headDim * bytesPerElement;
  return {
    bytes_per_token: perToken,
    kb_per_token: round(perToken / 1024, 1),
    mb_for_2k: round((perToken * 2048) / 1e6, 1),
    mb_for_4k: round((perToken * 4096) / 1e6, 1),
    mb_for_8k: round((perToken * 8192) / 1e6, 1),
    mb_for_16k: round((perToken * 16384) / 1e6, 1),
  };
}

export function recommendRuntime(report) {
  const reachable = report.runtimes.filter((r) => r.reachable);
  if (reachable.length === 0) {
    return {
      status: 'no_runtime',
      message: 'No local OpenAI-compatible endpoint is reachable. Start Ollama, LM Studio or textgen, or set endpoint.baseUrl in .agent/config.json.',
    };
  }
  const gpu = report.hardware.gpu;
  const freeVram = Array.isArray(gpu) ? gpu[0]?.vram_free_mb : null;
  return {
    status: 'ok',
    runtimes: reachable.map((r) => ({ id: r.id, name: r.name, base_url: r.base_url, models: r.models })),
    vram_total_mb: Array.isArray(gpu) ? gpu[0]?.vram_total_mb : null,
    vram_free_mb: freeVram,
    advice: freeVram !== null && freeVram < 1200
      ? 'Less than 1.2GB VRAM is free. Avoid loading a second model concurrently; unload the current model before switching.'
      : 'Enough VRAM may be available for a small additional model; verify with a measured load test.',
  };
}

export async function probeEndpointModel({ baseUrl, model, timeoutMs = 180000 }) {
  const client = new OpenAIClient({ baseUrl, model, timeoutMs, label: 'probe' });
  return client.probeCapabilities();
}

export function createClient(config, { model = null, role = 'primary', audit = null } = {}) {
  const cfg = role === 'vision' && config.vision?.baseUrl
    ? { baseUrl: config.vision.baseUrl, model: config.vision.model, apiKey: config.vision.apiKey }
    : { baseUrl: config.endpoint.baseUrl, model: model ?? config.endpoint.model, apiKey: config.endpoint.apiKey };
  return new OpenAIClient({
    ...cfg,
    timeoutMs: config.endpoint.timeoutMs,
    temperature: config.endpoint.temperature,
    maxOutputTokens: config.endpoint.maxOutputTokens,
    audit,
    label: role,
  });
}

function round(n, digits = 1) {
  return Math.round(n * 10 ** digits) / 10 ** digits;
}
