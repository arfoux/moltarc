// CLI e2e part 3: p2p-sync -> asof -> migrate through the binary.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { startNode } from '../src/p2p.js';
import { needsMigration } from '../src/migrate.js';
import { scratch, writeHotLog } from './util.js';
import * as idx from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });
}

// Async variant: execFileSync blocks the parent event loop, which starves an
// in-parent startNode server of its upgrade/message handlers mid-handshake.
// The p2p-sync leg awaits the child so the loop stays alive to serve it.
function runAsync(...args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`p2p-sync failed: ${String(stderr) || err.message}`));
      else resolve(String(stdout));
    });
  });
}

describe('cli3: barrel + new subcommands', () => {
  it('index re-exports all ten modules', { timeout: 30_000 }, () => {
    const syms = [
      ['p2p', 'syncFromPeer'],
      ['timetravel', 'queryAsOf'],
      ['migrate', 'migrate'],
      ['readonly', 'openArchiveReadOnly'],
      ['alerts', 'checkUnacked'],
      ['sensor', 'downsample'],
      ['ticket', 'issueTicket'],
      ['bundle', 'packBundle'],
      ['thumb', 'makeThumb'],
      ['cas', 'casPut'],
    ] as const;
    for (const [mod, sym] of syms) {
      assert.equal(typeof (idx as Record<string, unknown>)[sym], 'function', `index must re-export ${mod}.${sym}`);
    }
  });

  it('p2p-sync pulls chunks from a live peer', { timeout: 60_000 }, async () => {
    const dir = scratch('cli3-p2p');
    const { hotDb } = writeHotLog(dir, { rows: 300 });
    const aDir = join(dir, 'a');
    const bDir = join(dir, 'b');
    const sealed = await seal({ hotDb, outDir: aDir });
    assert.ok(sealed.chunks.length >= 1);
    const node = startNode({ outDir: aDir, port: 0 });
    try {
      const out = await runAsync('p2p-sync', node.url, bDir);
      assert.match(out, /synced [1-9]\d* chunk\(s\)/);
      const again = await runAsync('p2p-sync', node.url, bDir);
      assert.match(again, /synced 0 chunk\(s\)/);
      const manifest = JSON.parse(readFileSync(join(bDir, 'manifest.json'), 'utf8')) as { chunks: unknown[] };
      assert.equal(manifest.chunks.length, sealed.chunks.length);
    } finally {
      node.stop();
    }
  });

  it('asof returns timestamp-scoped rows', { timeout: 60_000 }, async () => {
    const dir = scratch('cli3-asof');
    const { hotDb } = writeHotLog(dir, { rows: 100 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const ts = 1_700_000_000_000 + 9 * 1000;
    const out = run('asof', outDir, String(ts));
    const rows = JSON.parse(out.split('\n')[0] as string) as { id: string }[];
    assert.equal(rows.length, 10);
    assert.equal(rows[0]?.id, 'trx-00000001');
    assert.equal(rows[9]?.id, 'trx-00000010');
    assert.match(out, /asof 10 row\(s\)/);
    const seqOut = run('asof', outDir, '--seq', '5');
    const seqRows = JSON.parse(seqOut.split('\n')[0] as string) as { id: string }[];
    assert.equal(seqRows.length, 5);
    assert.throws(() => run('asof', outDir, 'not-a-number'));
  });

  it('migrate heals a version-0 manifest', { timeout: 60_000 }, async () => {
    const dir = scratch('cli3-migrate');
    const { hotDb } = writeHotLog(dir, { rows: 50 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    // Downgrade to a genuinely old shape: v0 envelope, no v1 index fields.
    const v0chunk = (e: Record<string, unknown>) => ({
      file: e.file,
      table: e.table,
      seqMin: e.seqMin,
      seqMax: e.seqMax,
      tsMin: e.tsMin,
      tsMax: e.tsMax,
      rows: e.rows,
      bytes: e.bytes,
      sha256: e.sha256,
      crc32c: e.crc32c,
      sealedBy: e.sealedBy,
    });
    for (const name of ['manifest.json', 'manifest.bak.json']) {
      const p = join(outDir, name);
      const m = JSON.parse(readFileSync(p, 'utf8')) as { chunks: Record<string, unknown>[]; createdAt: string };
      writeFileSync(p, `${JSON.stringify({ version: 0, createdAt: m.createdAt, chunks: m.chunks.map(v0chunk) }, null, 1)}\n`);
    }
    assert.equal(needsMigration(outDir), true);
    const dry = run('migrate', outDir, '--dry-run');
    assert.match(dry, /dry-run: would rebuild/);
    assert.equal(needsMigration(outDir), true, 'dry-run writes nothing');
    const applied = run('migrate', outDir);
    assert.match(applied, /rebuilt \d+ entr/);
    assert.equal(needsMigration(outDir), false);
  });
});
