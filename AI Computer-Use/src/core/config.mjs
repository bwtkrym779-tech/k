import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const AUTONOMY_LEVELS = ['observe', 'assisted', 'supervised', 'autonomous'];

export const DEFAULTS = {
  endpoint: {
    baseUrl: 'http://127.0.0.1:5000/v1',
    model: null,
    apiKey: null,
    timeoutMs: 180000,
    temperature: 0.1,
    maxOutputTokens: 900,
  },
  vision: {
    enabled: false,
    baseUrl: null,
    model: null,
    apiKey: null,
    verified: false,
    note: 'Disabled by default. Enable only after scripts/verify_vision.mjs proves the model reads image pixels.',
  },
  autonomy: 'supervised',
  limits: {
    maxSteps: 20,
    maxActions: 40,
    maxDurationMs: 15 * 60 * 1000,
    stepTimeoutMs: 120000,
    actionTimeoutMs: 30000,
    retriesPerAction: 2,
    consecutiveFailureLimit: 3,
    maxRepeatedActions: 2,
  },
  workspace: null, // resolved to <root>/workspace
  allowedDirs: [],
  approvedApps: ['notepad', 'calc', 'mspaint', 'explorer', 'code', 'winword', 'excel', 'notepad++'],
  commandAllowlist: ['node', 'npm', 'git', 'dir', 'echo'],
  sensitivePatterns: [
    '**/.ssh/**', '**/.aws/**', '**/id_rsa*', '**/*.pem', '**/*.pfx',
    '**/.env', '**/.env.*', '**/credentials*', '**/Cookies', '**/Login Data',
  ],
  screenshots: {
    dir: null,
    maxFiles: 80,
    maxAgeHours: 24,
    maskPasswordFields: true,
  },
  browser: {
    executable: null,
    port: 9222,
    profileDir: null,
    headless: false,
    allowedSchemes: ['http:', 'https:'],
    timeoutMs: 30000,
  },
  research: {
    enabled: true,
    maxResults: 6,
    timeoutMs: 20000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalComputerAgent/1.0',
  },
  server: {
    host: '127.0.0.1',
    port: 4317,
    tokenTtlHours: 12,
  },
  estop: {
    hotkey: 'ctrl+alt+shift+f12',
    file: null,
  },
  perception: {
    cacheTtlMs: 1500,
    uiTreeDepth: 4,
    maxNodes: 250,
    ocrMaxAgeMs: 8000,
    changeThreshold: 6,
  },
  dryRun: false,
  logLevel: 'info',
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== 'object' || base === null || typeof override !== 'object' || override === null) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

export class Config {
  constructor(root, raw) {
    this.root = path.resolve(root);
    this.raw = raw;
    this.endpoint = raw.endpoint;
    this.vision = raw.vision;
    this.autonomy = raw.autonomy;
    this.limits = raw.limits;
    this.workspace = path.resolve(raw.workspace ?? path.join(this.root, 'workspace'));
    this.allowedDirs = uniquePaths([this.workspace, ...(raw.allowedDirs ?? [])].map((p) => path.resolve(this.root, p)));
    this.approvedApps = raw.approvedApps;
    this.commandAllowlist = raw.commandAllowlist;
    this.sensitivePatterns = raw.sensitivePatterns;
    this.screenshots = {
      ...raw.screenshots,
      dir: path.resolve(raw.screenshots.dir ?? path.join(this.root, '.agent', 'screenshots')),
    };
    this.browser = {
      ...raw.browser,
      profileDir: path.resolve(raw.browser.profileDir ?? path.join(this.root, '.agent', 'browser-profile')),
    };
    this.research = raw.research;
    this.server = raw.server;
    this.estop = {
      ...raw.estop,
      file: path.resolve(raw.estop.file ?? path.join(this.root, '.agent', 'STOP')),
    };
    this.perception = raw.perception;
    this.dryRun = raw.dryRun;
    this.logLevel = raw.logLevel;
    this.stateDir = path.join(this.root, '.agent');
    this.logDir = path.join(this.stateDir, 'logs');
    this.sessionDir = path.join(this.stateDir, 'sessions');
    this.artifactDir = path.join(this.stateDir, 'artifacts');
  }

  ensureDirs() {
    for (const dir of [this.stateDir, this.logDir, this.sessionDir, this.artifactDir, this.workspace, this.screenshots.dir]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  isAllowedPath(target, { write = false } = {}) {
    const resolved = path.resolve(target);
    return this.allowedDirs.some((dir) => {
      if (resolved === dir) return true;
      const rel = path.relative(dir, resolved);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
      if (write && isWindowsSystemPath(resolved)) return false;
      return true;
    });
  }
}

function isWindowsSystemPath(p) {
  const lower = p.toLowerCase();
  const systemRoot = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase();
  return lower.startsWith(systemRoot + '\\') || lower.startsWith('c:\\program files');
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

export function loadConfig(root = process.cwd(), overrides = {}) {
  const configPath = path.join(root, '.agent', 'config.json');
  let fileConfig = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid .agent/config.json: ${err.message}`);
    }
  }
  const envConfig = {};
  if (process.env.LCA_ENDPOINT) envConfig.endpoint = { baseUrl: process.env.LCA_ENDPOINT };
  if (process.env.LCA_MODEL) envConfig.endpoint = { ...(envConfig.endpoint ?? {}), model: process.env.LCA_MODEL };
  if (process.env.LCA_AUTONOMY) envConfig.autonomy = process.env.LCA_AUTONOMY;
  if (process.env.LCA_PORT) envConfig.server = { port: Number(process.env.LCA_PORT) };
  if (process.env.LCA_DRY_RUN === '1') envConfig.dryRun = true;

  const merged = deepMerge(deepMerge(DEFAULTS, fileConfig), deepMerge(envConfig, overrides));
  if (!AUTONOMY_LEVELS.includes(merged.autonomy)) {
    throw new Error(`Invalid autonomy level '${merged.autonomy}'. Use one of: ${AUTONOMY_LEVELS.join(', ')}`);
  }
  const cfg = new Config(root, merged);
  cfg.ensureDirs();
  return cfg;
}

export function writeDefaultConfig(root = process.cwd()) {
  const dir = path.join(root, '.agent');
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'config.json');
  if (existsSync(target)) return { created: false, path: target };
  const example = {
    endpoint: { baseUrl: 'http://127.0.0.1:5000/v1', model: 'model2.gguf' },
    autonomy: 'supervised',
    dryRun: false,
    limits: { maxSteps: 20, maxActions: 40 },
  };
  writeFileSync(target, JSON.stringify(example, null, 2) + '\n', 'utf8');
  return { created: true, path: target };
}
