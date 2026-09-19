#!/usr/bin/env node
// bin/moltarc.js — npm bin shim (valid .js entry). Exec bun on sibling TS entry; clear fallback when bun missing.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const entry = join(dir, 'moltarc.ts');
const r = spawnSync('bun', [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) {
  if (r.error.code === 'ENOENT') {
    console.error('moltarc needs the Bun runtime (https://bun.sh). Install Bun, then retry: bun bin/moltarc.ts --help');
    process.exit(1);
  }
  console.error(r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
