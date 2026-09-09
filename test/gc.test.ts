// gc tests: orphan sweep (dry-run default, apply removes only orphans),
// seal reserve-space refusal, status output.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { loadManifest } from '../src/manifest.js';
import { ship } from '../src/ship.js';
import { forgetChunks } from '../src/cold.js';
import { sweep } from '../src/gc.js';
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function plantOrphan(outDir: string): string {
  const name = 'events-000999-000999-deadbeef.chk';
  writeFileSync(join(outDir, 'warm', name), Buffer.from('orphan-bytes'));
  return name;
}

describe('gc orphan sweep', () => {
  it('dry-run is the default and changes nothing', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-dry');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    const sealed = await seal({ hotDb, outDir });
    assert.ok(sealed.chunks.length >= 1);
    const orphan = plantOrphan(outDir);
    const r = sweep(outDir);
    assert.equal(r.dryRun, true);
    assert.ok(r.orphans.includes(orphan));
    assert.ok(existsSync(join(outDir, 'warm', orphan)), 'dry-run deletes nothing');
    assert.equal(r.removed.length, 0);
  });

  it('apply removes only acked orphans, live chunks and unacked garbage survive', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-apply');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    // Two devices seal two chunks, so one survives as the live control.
    for (const device of ['pos-01', 'pos-02']) {
      const { hotDb } = writeHotLog(dir, { rows: 200, device, table: `t-${device}` });
      await seal({ hotDb, outDir });
    }
    const { manifest } = loadManifest(outDir);
    assert.equal(manifest.chunks.length, 2);
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    // Forget one shipped chunk: its warm bytes turn into an acked orphan.
    const victim = manifest.chunks[0].file;
    const survivor = manifest.chunks[1].file;
    forgetChunks(outDir, [victim], relayDir);
    const garbage = plantOrphan(outDir);
    const r = sweep(outDir, { dryRun: false, relayDir });
    assert.equal(r.dryRun, false);
    assert.deepEqual(r.removed, [victim], 'acked orphan collected');
    assert.ok(!existsSync(join(outDir, 'warm', victim)), 'orphan removed');
    assert.ok(r.skippedUnacked.includes(garbage), 'unacked garbage retained');
    assert.ok(existsSync(join(outDir, 'warm', garbage)), 'garbage bytes stay');
    assert.ok(existsSync(join(outDir, 'warm', survivor)), `live chunk kept: ${survivor}`);
    assert.ok(r.bytesReclaimed > 0);
  });
});

describe('seal reserve space', () => {
  it('refuses gracefully below 50MB free and half-writes nothing', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-reserve');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await assert.rejects(
      seal({ hotDb, outDir, freeSpaceBytes: 1024 }),
      /50MB reserve/,
    );
    assert.deepEqual(readdirSync(join(outDir, 'warm')), [], 'no chunk half-written');
    assert.ok(!existsSync(join(outDir, 'sealed_upto_seq')), 'no watermark half-written');
    assert.ok(!existsSync(join(outDir, 'manifest.json')), 'no manifest half-written');
  });
});

describe('status command', () => {
  it('prints chunk counts, sizes, and unacked', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-status');
    const { hotDb } = writeHotLog(dir, { rows: 300 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });

    const before = run('status', outDir, relayDir);
    assert.match(before, /chunks: \d+/);
    assert.match(before, /bytes: \d+/);
    assert.match(before, /unacked: [1-9]\d*/);

    run('ship', outDir, relayDir);
    const after = run('status', outDir, relayDir);
    assert.match(after, /unacked: 0/);
  });
});
