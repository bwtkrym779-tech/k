#!/usr/bin/env node
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server/http.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : undefined;

const { url, runtime, server } = await startServer({ root, port, echo: args.includes('--echo') });
const pidFile = path.join(runtime.config.stateDir, 'server.json');
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, url, started_at: new Date().toISOString() }, null, 2) + '\n', 'utf8');

console.log(`local-computer-use server listening on ${url}`);
console.log(`model: ${runtime.primary.model} · tools: ${runtime.registry.list().length} · autonomy: ${runtime.config.autonomy}`);
console.log(`health: ${url}/health`);
console.log(`stop file: ${runtime.config.estop.file}`);

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  console.log(`\n[${signal}] shutting down…`);
  try { server.close(); } catch { /* ignore */ }
  try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
  await runtime.dispose().catch(() => null);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
