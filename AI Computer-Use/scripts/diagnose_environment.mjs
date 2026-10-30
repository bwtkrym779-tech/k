#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { loadConfig, writeDefaultConfig } from '../src/core/config.mjs';
import { detectRuntimes, hardwareInfo, findLocalModelFiles, probeEndpointModel } from '../src/model/detect.mjs';
import { WinHost } from '../src/winhost/client.mjs';

/**
 * Read-only environment diagnosis. No downloads, no installs, no model swaps.
 *   node scripts/diagnose_environment.mjs [--json] [--probe]
 * --probe performs live model capability probes (tool calling, JSON, Arabic, vision).
 */
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const probe = argv.includes('--probe');
const root = process.cwd();

const config = loadConfig(root);
const created = writeDefaultConfig(root);
const runtimeProbe = await detectRuntimes();
const hw = hardwareInfo();
const ggufs = findLocalModelFiles();

let opencode = null;
try {
  opencode = execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
} catch {
  const cli = path_join(process.env.LOCALAPPDATA ?? '', 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe');
  try { opencode = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim(); } catch (err) { opencode = `not found (${err.code ?? err.message})`; }
}

// Windows automation host: prove it starts and can see the screen / OCR.
let hostInfo = null;
const host = new WinHost({ root, screenshotDir: config.screenshots.dir });
try {
  await host.start();
  const ping = await host.call('ping');
  const screen = await host.call('screen_info');
  hostInfo = {
    ok: true,
    ping,
    screen: {
      virtual_screen: screen.virtual_screen,
      monitors: screen.monitors,
      dpi_scale: screen.dpi_scale,
      foreground: screen.foreground?.title ?? null,
      ocr_languages: screen.ocr_languages,
    },
  };
} catch (err) {
  hostInfo = { ok: false, error: err.message, stderr: host.stderrTail.slice(-2000) };
} finally {
  await host.dispose();
}

let capabilities = null;
if (probe) {
  const model = config.endpoint.model ?? runtimeProbe.find((r) => r.reachable)?.models?.[0]?.id ?? null;
  if (!model) {
    capabilities = { error: 'No model configured and no runtime models found.' };
  } else {
    capabilities = await probeEndpointModel({ baseUrl: config.endpoint.baseUrl, model });
  }
}

const report = {
  generated_at: new Date().toISOString(),
  platform: { os: `${os.type()} ${os.release()}`, arch: os.arch(), hostname: os.hostname(), node: process.version },
  workspace: config.root,
  config_file: { created_now: created.created, path: created.path },
  hardware: hw,
  runtimes: runtimeProbe.map((r) => ({
    id: r.id, name: r.name, port: r.port, reachable: r.reachable,
    models: r.models ?? [], error: r.error ?? undefined,
  })),
  local_gguf_models: ggufs.map((g) => ({
    name: g.name, path: g.path, size_gb: g.size_gb,
    family: g.metadata?.architecture ?? null,
    name_meta: g.metadata?.name ?? null,
    context_length: g.metadata?.context_length ?? null,
    layers: g.metadata?.block_count ?? null,
    chat_template_has_tools: g.metadata?.chat_template ? /tools/.test(String(g.metadata.chat_template)) : null,
  })),
  opencode,
  windows_host: hostInfo,
  configured: {
    endpoint: config.endpoint.baseUrl,
    model: config.endpoint.model,
    autonomy: config.autonomy,
    dry_run: config.dryRun,
    vision: { enabled: config.vision.enabled, model: config.vision.model },
    estop_file: config.estop.file,
    workspace: config.workspace,
  },
  capabilities,
  recommendations: [],
};

if (!hw.gpu || hw.gpu.error) report.recommendations.push('GPU not detected via nvidia-smi; CPU-only inference will be slow.');
else if (hw.gpu[0].vram_free_mb < 1500) report.recommendations.push(`Only ${hw.gpu[0].vram_free_mb} MB VRAM free; unload other models before running the agent.`);
if (capabilities?.vision && capabilities.vision.verified === false) {
  report.recommendations.push('Vision is not verified: keep vision.enabled=false and rely on UI Automation + OCR.');
}
if (!hostInfo.ok) report.recommendations.push('The Windows automation host failed to start; fix that before using computer.* tools.');

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  print(report);
}

function print(r) {
  const line = (s = '') => console.log(s);
  line('LOCAL COMPUTER-USE — ENVIRONMENT DIAGNOSIS');
  line(`generated ${r.generated_at}`);
  line('');
  line(`OS        ${r.platform.os} (${r.platform.arch})  node ${r.platform.node}`);
  line(`CPU       ${r.hardware.cpu.model} · ${r.hardware.cpu.cores} threads`);
  line(`RAM       ${r.hardware.memory.total_gb} GB total · ${r.hardware.memory.free_gb} GB free`);
  if (Array.isArray(r.hardware.gpu)) {
    for (const g of r.hardware.gpu) line(`GPU       ${g.name} · driver ${g.driver} · VRAM ${g.vram_used_mb}/${g.vram_total_mb} MB used (${g.vram_free_mb} MB free) · ${g.temperature_c}°C`);
  } else line(`GPU       ${r.hardware.gpu?.error ?? 'unknown'}`);
  line(`OpenCode  ${r.opencode}`);
  line('');
  line('MODEL RUNTIMES');
  for (const rt of r.runtimes.filter((x) => x.reachable)) {
    line(`  ✓ ${rt.name} :${rt.port} — models: ${rt.models.map((m) => m.id).join(', ') || '(none listed)'}`);
  }
  if (!r.runtimes.some((x) => x.reachable)) line('  none reachable');
  line('');
  line('LOCAL GGUF FILES');
  if (r.local_gguf_models.length === 0) line('  none found');
  for (const g of r.local_gguf_models) {
    line(`  ${g.name} · ${g.size_gb} GB · ${g.family ?? '?'} · ctx ${g.context_length ?? '?'} · tools in chat template: ${g.chat_template_has_tools}`);
  }
  line('');
  line('WINDOWS HOST');
  if (r.windows_host.ok) {
    const s = r.windows_host.screen;
    line(`  ✓ ready · PowerShell ${r.windows_host.ping.ps} · screen ${s.virtual_screen.width}x${s.virtual_screen.height} @ ${s.dpi_scale}x · OCR: ${s.ocr_languages.join(', ')}`);
    line(`  foreground: ${s.foreground}`);
  } else {
    line(`  ✗ ${r.windows_host.error}`);
  }
  line('');
  line('CONFIGURED');
  line(`  endpoint ${r.configured.endpoint} · model ${r.configured.model ?? '(auto)'}`);
  line(`  autonomy ${r.configured.autonomy} · dry-run ${r.configured.dry_run} · vision ${r.configured.vision.enabled ? r.configured.vision.model : 'disabled'}`);
  line(`  workspace ${r.configured.workspace}`);
  line(`  stop file ${r.configured.estop_file}`);
  if (r.capabilities) {
    line('');
    line('CAPABILITY PROBE');
    if (r.capabilities.error) line(`  ${r.capabilities.error}`);
    else {
      line(`  text ${r.capabilities.text.supported ? '✓' : '✗'} · tools ${r.capabilities.tools.supported ? '✓' : '✗'} · json_schema ${r.capabilities.json_schema.supported ? '✓' : '✗'} · arabic ${r.capabilities.arabic.supported ? '✓' : '✗'} · vision ${r.capabilities.vision.verified ? '✓' : '✗'}`);
      line(`  vision: ${r.capabilities.vision.reason}`);
    }
  }
  if (r.recommendations.length) {
    line('');
    line('RECOMMENDATIONS');
    for (const rec of r.recommendations) line(`  • ${rec}`);
  }
}

function path_join(...parts) {
  return parts.filter(Boolean).join('\\');
}
