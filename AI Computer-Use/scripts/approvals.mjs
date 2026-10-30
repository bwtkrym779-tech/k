#!/usr/bin/env node
import path from 'node:path';
import { loadConfig } from '../src/core/config.mjs';
import { Approvals } from '../src/safety/approvals.mjs';

const argv = process.argv.slice(2);
const [cmd = 'list', id, ...rest] = argv;
const reasonIdx = rest.indexOf('--reason');
const reason = reasonIdx >= 0 ? rest[reasonIdx + 1] : null;

const config = loadConfig(process.cwd());
const approvals = new Approvals({ file: path.join(config.stateDir, 'approvals.json') });

if (cmd === 'list') {
  const statusIdx = argv.indexOf('--status');
  const status = statusIdx >= 0 ? argv[statusIdx + 1] : 'pending';
  const items = approvals.list({ status: status === 'all' ? null : status });
  if (items.length === 0) {
    console.log(`No ${status} approval requests.`);
  } else {
    for (const r of items) {
      console.log(`${r.id}  [${r.status}]  ${r.tool}  risk=${r.risk}`);
      console.log(`  ${r.summary}`);
      console.log(`  requested ${r.created_at} · expires ${r.expires_at}`);
      console.log(`  args: ${JSON.stringify(r.args_preview).slice(0, 300)}`);
    }
  }
  process.exit(0);
}

if (!id) {
  console.error('Usage: node scripts/approvals.mjs list [--status pending|granted|denied|consumed|all]');
  console.error('       node scripts/approvals.mjs grant <apr_id> [--reason "why"]');
  console.error('       node scripts/approvals.mjs deny  <apr_id> [--reason "why"]');
  process.exit(2);
}

const result = cmd === 'grant'
  ? approvals.grant(id, { by: 'cli-user', reason })
  : cmd === 'deny'
    ? approvals.deny(id, { by: 'cli-user', reason })
    : { ok: false, reason: `Unknown command '${cmd}'` };

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
