// gc relay-gate regressions (rule 7): gc --apply only deletes relay-acked
// chunks, so apply without a relay must fail loudly instead of silently
// retaining; dry-run without a relay stays honest (lists + retains).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { loadManifest } from '../src/manifest.js';
import { forgetChunks } from '../src/cold.js';
import { sweep } from '../src/gc.js';
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function plantOrphan(outDir: string, name: string): string {
  writeFileSync(join(outDir, 'warm', name), Buffer.from('orphan-bytes'));
  return name;
}

describe('gc relay gate (rule 7)', () => {
  it('apply without relayDir throws and deletes nothing', { timeout: 30_000 }, async () => {
    const dir = scratch('gcrelay-apply-norelay');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const orphan = plantOrphan(outDir, 'events-000777-000777-feedface.chk');
    assert.throws(
      () => sweep(outDir, { dryRun: false }),
      /gc only deletes relay-acked chunks \(rule 7\)/,
      'apply without relay must name rule 7',
    );
    assert.throws(() => sweep(outDir, { dryRun: false, relayDir: '' }), /requires relay/);
    assert.ok(existsSync(join(outDir, 'warm', orphan)), 'throw lands before any delete');
  });

  it('dry-run without relayDir stays honest: lists, retains, deletes nothing', { timeout: 30_000 }, async () => {
    const dir = scratch('gcrelay-dry-norelay');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const orphan = plantOrphan(outDir, 'events-000778-000778-feedface.chk');
    const r = sweep(outDir);
    assert.equal(r.dryRun, true);
    assert.ok(r.orphans.includes(orphan), 'orphan still listed');
    assert.ok(r.skippedUnacked.includes(orphan), 'unknown-ack orphan retained');
    assert.deepEqual(r.removed, [], 'dry-run deletes nothing');
    assert.ok(existsSync(join(outDir, 'warm', orphan)), 'orphan bytes stay on disk');
  });

  it('apply with relay still collects acked orphans and retains unacked garbage', { timeout: 30_000 }, async () => {
    const dir = scratch('gcrelay-apply-relay');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    for (const device of ['dev-01', 'dev-02']) {
      const { hotDb } = writeHotLog(dir, { rows: 200, device, table: `t-${device}` });
      await seal({ hotDb, outDir });
    }
    const { manifest } = loadManifest(outDir);
    assert.equal(manifest.chunks.length, 2);
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const victim = manifest.chunks[0].file;
    const survivor = manifest.chunks[1].file;
    forgetChunks(outDir, [victim], relayDir);
    const garbage = plantOrphan(outDir, 'events-000888-000888-cafebabe.chk');
    const r = sweep(outDir, { dryRun: false, relayDir });
    assert.deepEqual(r.removed, [victim], 'acked orphan collected');
    assert.ok(!existsSync(join(outDir, 'warm', victim)), 'orphan removed');
    assert.ok(r.skippedUnacked.includes(garbage), 'unacked garbage retained');
    assert.ok(existsSync(join(outDir, 'warm', garbage)), 'garbage bytes stay');
    assert.ok(existsSync(join(outDir, 'warm', survivor)), `live chunk kept: ${survivor}`);
  });

  it('cli gc --apply without relay exits non-zero naming rule 7', { timeout: 30_000 }, async () => {
    const dir = scratch('gcrelay-cli-norelay');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const orphan = plantOrphan(outDir, 'events-000779-000779-feedface.chk');
    let text = '';
    try {
      run('gc', outDir, '--apply');
    } catch (e: unknown) {
      const err = e as { stderr?: Buffer | string; message?: string };
      text = String(err.stderr ?? err.message ?? e);
    }
    assert.match(text, /relay-acked chunks \(rule 7\)/, `cli must name rule 7, got:\n${text}`);
    assert.ok(existsSync(join(outDir, 'warm', orphan)), 'failed apply deletes nothing');
  });
});
