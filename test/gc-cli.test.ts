// gc cli tests: real binary dry-run, apply, fail-closed no-relay, usage failure.
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
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function runFail(...args: string[]): string {
  try {
    run(...args);
  } catch (e: unknown) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const text = String(err.stderr ?? err.message ?? e);
    return text;
  }
  assert.fail(`expected failure: ${args.join(' ')}`);
}

function plantOrphan(outDir: string, name: string): string {
  writeFileSync(join(outDir, 'warm', name), Buffer.from('orphan-bytes'));
  return name;
}

describe('gc cli', () => {
  it('dry-run is the default and deletes nothing', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-cli-dry');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    const orphan = plantOrphan(outDir, 'events-000999-000999-deadbeef.chk');
    const out = run('gc', outDir, relayDir);
    assert.match(out, /dry-run/);
    assert.ok(out.includes(`orphan ${orphan}`), `missing orphan line:\n${out}`);
    assert.ok(existsSync(join(outDir, 'warm', orphan)), 'dry-run deletes nothing');
  });

  it('apply removes acked orphans and retains unacked garbage', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-cli-apply');
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
    const out = run('gc', outDir, relayDir, '--apply');
    assert.match(out, /swept/);
    assert.ok(out.includes(`removed ${victim}`), `missing removed line:\n${out}`);
    assert.ok(out.includes(`retained ${garbage}`), `missing retained line:\n${out}`);
    assert.ok(!existsSync(join(outDir, 'warm', victim)), 'acked orphan removed');
    assert.ok(existsSync(join(outDir, 'warm', garbage)), 'unacked garbage retained');
    assert.ok(existsSync(join(outDir, 'warm', survivor)), `live chunk kept: ${survivor}`);
  });

  it('fail-closed without relay: apply throws and removes nothing', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-cli-norelay');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const orphan = plantOrphan(outDir, 'events-000777-000777-feedface.chk');
    const text = runFail('gc', outDir, '--apply');
    assert.match(text, /gc --apply requires relayDir/, `apply without relay must throw:\n${text}`);
    assert.ok(existsSync(join(outDir, 'warm', orphan)), 'fail-closed: orphan retained');
  });

  it('reports tmp litter without deleting live chunks', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-cli-litter');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    writeFileSync(join(outDir, 'warm', 'x.chk.tmp.123'), Buffer.from('crashed-writer-fragment'));
    const out = run('gc', outDir);
    assert.ok(out.includes('litter 1 tmp file(s) collected'), `missing litter line:\n${out}`);
  });

  it('usage failure without outDir', { timeout: 30_000 }, () => {
    const text = runFail('gc');
    assert.match(text, /usage: moltarc gc <outDir> \[relayDir\] \[--apply\]/);
  });

  it('forget notes bytes remain until gc + coldg', { timeout: 30_000 }, async () => {
    const dir = scratch('gc-cli-forget-note');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const { manifest } = loadManifest(outDir);
    assert.ok(manifest.chunks.length >= 1);
    const victim = manifest.chunks[0].file;
    const out = run('forget', outDir, relayDir, victim);
    assert.ok(out.includes(`forgot ${victim}`), `missing forgot line:\n${out}`);
    assert.ok(out.includes('note: bytes remain until gc --apply + coldg --apply'), `missing note line:\n${out}`);
  });
});
