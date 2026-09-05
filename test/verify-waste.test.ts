// moltarc verify waste-fix regressions: atomic repair writes, scanChunk refill,
// strict manifest parse in quarantine/repair, filename-link enforcement.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HEADER_SIZE, sha256hex } from '../src/chunk.js';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { loadManifest, saveManifestAtomic } from '../src/manifest.js';
import { quarantine, repairAll, repairByHash, verifyFull } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

async function shippedArchive(name: string, rows: number): Promise<{ outDir: string; relayDir: string; files: string[] }> {
  const dir = scratch(name);
  const { hotDb } = writeHotLog(dir, { rows, uniqueBodies: true });
  const outDir = join(dir, 'archive');
  const relayDir = join(dir, 'relay');
  const sealed = await seal({ hotDb, outDir, targetBytes: 8 * 1024 });
  assert.ok(sealed.chunks.length >= 1, `need >=1 chunk, got ${sealed.chunks.length}`);
  await ship({ outDir, relayDir, baseDelayMs: 1 });
  return { outDir, relayDir, files: sealed.chunks.map((c) => c.split(/[\\/]/).pop() as string) };
}

function tmpLeftovers(outDir: string): string[] {
  return readdirSync(join(outDir, 'warm')).filter((f) => f.includes('.tmp.'));
}

describe('verify waste-fix', () => {
  it('repair writes atomically: replace-not-truncate, exact relay bytes, no tmp residue', { timeout: 30_000 }, async () => {
    const { outDir, relayDir, files } = await shippedArchive('vw-atomic', 2500);
    const victim = files[1] ?? files[0];
    const full = join(outDir, 'warm', victim);
    const buf = Buffer.from(readFileSync(full));
    buf[HEADER_SIZE + 11] ^= 0x01;
    writeFileSync(full, buf);
    const before = statSync(full);
    repairByHash(outDir, relayDir, victim);
    const afterStat = statSync(full);
    assert.notEqual(afterStat.birthtimeMs, before.birthtimeMs, 'dest replaced via rename, not truncated in place');
    assert.deepEqual(tmpLeftovers(outDir), []);
    const { manifest } = loadManifest(outDir);
    const entry = manifest.chunks.find((e) => e.file === victim);
    assert.ok(entry && !entry.quarantined);
    assert.equal(sha256hex(Buffer.from(readFileSync(join(outDir, 'warm', victim)))), entry.sha256);
  });

  it('repair refills crc/bloom/minmax/rows via scanChunk, no blind stubs', { timeout: 30_000 }, async () => {
    const { outDir, relayDir, files } = await shippedArchive('vw-refill', 2500);
    const victim = files[0];
    const loaded = loadManifest(outDir);
    const entry = loaded.manifest.chunks.find((e) => e.file === victim);
    assert.ok(entry);
    entry.quarantined = true;
    entry.bloom = '';
    entry.minKey = '';
    entry.maxKey = '';
    entry.rows = 0;
    entry.crc32c = 0;
    saveManifestAtomic(outDir, loaded.manifest);
    const full = join(outDir, 'warm', victim);
    const buf = Buffer.from(readFileSync(full));
    buf[HEADER_SIZE + 5] ^= 0xff;
    writeFileSync(full, buf);
    repairByHash(outDir, relayDir, victim);
    assert.deepEqual(tmpLeftovers(outDir), []);
    const after = loadManifest(outDir).manifest.chunks.find((e) => e.file === victim);
    assert.ok(after && !after.quarantined);
    assert.ok(after.rows > 0, 'rows refilled');
    assert.notEqual(after.crc32c, 0, 'crc refilled');
    assert.ok(after.bloom.length > 0, 'bloom refilled');
    assert.ok(after.minKey.length > 0 && after.maxKey.length > 0, 'minmax refilled');
    assert.equal(verifyFull(outDir).ok, true);
  });

  it('quarantine/repair reject source:none and never auto-rebuild', { timeout: 30_000 }, async () => {
    const { outDir, relayDir, files } = await shippedArchive('vw-strict', 1200);
    unlinkSync(join(outDir, 'manifest.json'));
    unlinkSync(join(outDir, 'manifest.bak.json'));
    assert.throws(() => quarantine(outDir, files[0]), /no readable manifest/);
    assert.throws(() => repairByHash(outDir, relayDir, files[0]), /no readable manifest/);
    const r = repairAll(outDir, relayDir);
    assert.equal(r.ok, false);
    assert.equal(r.repaired.length, 0);
    assert.equal(r.verify.manifest.source, 'none');
    assert.ok(!existsSync(join(outDir, 'manifest.json')), 'never auto-rebuilt');
    assert.ok(existsSync(join(outDir, 'warm', files[0])), 'quarantine threw before moving bytes');
  });

  it('non-matching filenames are CORRUPT, not skipped', { timeout: 30_000 }, async () => {
    const { outDir, files } = await shippedArchive('vw-namelink', 1200);
    const victim = files[0];
    const loaded = loadManifest(outDir);
    const entry = loaded.manifest.chunks.find((e) => e.file === victim);
    assert.ok(entry);
    renameSync(join(outDir, 'warm', victim), join(outDir, 'warm', 'oddname.chk'));
    entry.file = 'oddname.chk';
    saveManifestAtomic(outDir, loaded.manifest);
    const v = verifyFull(outDir);
    const item = v.items.find((i) => i.file === 'oddname.chk');
    assert.ok(item, 'entry still walked');
    assert.equal(item.status, 'CORRUPT');
    assert.match(item.reason ?? '', /filename link missing/);
    assert.ok(!v.ok);
  });
});
