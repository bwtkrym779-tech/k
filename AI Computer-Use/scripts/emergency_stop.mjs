#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/core/config.mjs';

/**
 * Emergency stop. Writes the stop-file checked before every model turn and
 * every tool call, and notifies a running server (which also cancels its abort
 * signal). `--clear` only removes the file; restart the agent afterwards.
 */
const config = loadConfig(process.cwd());
const args = process.argv.slice(2);
const clear = args.includes('--clear');
const pidFile = path.join(config.stateDir, 'server.json');

if (clear) {
  if (existsSync(config.estop.file)) rmSync(config.estop.file, { force: true });
  console.log(`Emergency stop cleared (${config.estop.file}).`);
  process.exit(0);
}

let viaServer = null;
if (existsSync(pidFile)) {
  try {
    const { url } = JSON.parse(readFileSync(pidFile, 'utf8'));
    const res = await fetch(`${url}/estop`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    viaServer = res.ok ? await res.json() : { status: res.status };
  } catch (err) {
    viaServer = { error: err.message };
  }
}

writeFileSync(config.estop.file, `${new Date().toISOString()} emergency stop\n`, 'utf8');
console.log(`EMERGENCY STOP engaged.`);
console.log(`  stop file: ${config.estop.file}`);
if (viaServer) console.log(`  server: ${JSON.stringify(viaServer)}`);
console.log('  The agent checks this file before every model turn and tool call.');
console.log('  Clear with: node scripts/emergency_stop.mjs --clear');
