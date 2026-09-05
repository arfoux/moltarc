// gc+cold waste-fix regressions: unacked-safe sweep default, orphan dict
// collection, dict-carrying cold segments, reserve fail-closed writes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { dictHex } from '../src/dict.js';
import { sweep } from '../src/gc.js';
import { loadManifest, saveManifestAtomic } from '../src/manifest.js';
import { quarantine } from '../src/verify.js';
import { forgetChunks, mergeCold, readTar, sweepCold } from '../src/cold.js';
import { scratch, writeHotLog } from './util.js';

function plantOrphan(outDir: string): string {
  const name = 'sales-000999-000999-deadbeef.chk';
  writeFileSync(join(outDir, 'warm', name), Buffer.from('orphan-bytes'));
  return name;
}

describe('gc+cold waste fixes', () => {
  it('sweep without relayDir retains every orphan (unacked-safe default)', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-unacked');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const orphan = plantOrphan(outDir);
    const r = sweep(outDir, { dryRun: false });
    assert.deepEqual(r.removed, [], 'no relayDir: nothing deleted, ack unknown');
    assert.deepEqual(r.skippedUnacked, [orphan], 'unknown-ack orphan reported retained');
    assert.ok(existsSync(join(outDir, 'warm', orphan)), 'orphan bytes stay on disk');
  });

  it('sweep collects orphan dicts and keeps live ones', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-dict');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    const { manifest } = loadManifest(outDir);
    assert.ok(manifest.chunks.some((e) => e.dictId !== 0), 'repetitive seal trains a dict');
    const live = readdirSync(join(outDir, 'dicts')).filter((f: string) => f.endsWith('.dict'));
    assert.ok(live.length >= 1, 'live dict file on disk');
    const dead = 'dict-deadbeef.dict';
    writeFileSync(join(outDir, 'dicts', dead), Buffer.from('dead-dict-bytes'));

    const dry = sweep(outDir, { dryRun: true, relayDir });
    assert.ok(dry.dictOrphans.includes(dead), 'dry-run reports the dead dict');
    assert.ok(!dry.dictOrphans.some((f) => live.includes(f)), 'live dicts never listed');
    assert.ok(existsSync(join(outDir, 'dicts', dead)), 'dry-run deletes nothing');

    const applied = sweep(outDir, { dryRun: false, relayDir });
    assert.deepEqual(applied.dictsRemoved, [dead], 'apply deletes only the dead dict');
    assert.ok(!existsSync(join(outDir, 'dicts', dead)), 'dead dict gone');
    assert.ok(applied.dictBytesReclaimed > 0, 'dict bytes accounted');
    for (const f of live) assert.ok(existsSync(join(outDir, 'dicts', f)), `live dict kept: ${f}`);
  });

  it('merge packs referenced dicts and refuses when the dict is missing', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-colddict');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const m = mergeCold(outDir);
    assert.ok(m.dicts.length >= 1, 'segment carries dict members');
    const names = readTar(readFileSync(join(outDir, 'cold', m.segment))).map((x) => x.name);
    for (const d of m.dicts) assert.ok(names.includes(d), `tar carries ${d}`);
    assert.ok(names.some((n) => n.startsWith('dicts/dict-') && n.endsWith('.dict')), 'dict member naming');

    // Forbid colding flagged chunks without their dict: drop the dict file,
    // seal fresh rows so a new chunk needs it, merge must refuse.
    const dir2 = scratch('gcw-coldnodict');
    const w2 = writeHotLog(dir2, { rows: 1500 });
    const out2 = join(dir2, 'archive');
    await seal({ hotDb: w2.hotDb, outDir: out2 });
    const dictFile = readdirSync(join(out2, 'dicts')).find((f: string) => f.endsWith('.dict'));
    assert.ok(dictFile, 'second archive trains a dict too');
    unlinkSync(join(out2, 'dicts', dictFile as string));
    assert.throws(() => mergeCold(out2), /need dict-.*\.dict/, 'merge refuses without the dict');
    assert.ok(!existsSync(join(out2, 'cold', 'seg-000001.tar')), 'refused merge writes no tar');
  });

  it('sweep keeps the dict of a chunk left on disk ahead of the manifest', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-torn');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    const { manifest } = loadManifest(outDir);
    const victim = manifest.chunks[0];
    assert.ok(victim.dictId !== 0, 'victim chunk needs its dict');
    // Simulate a kill mid-seal: chunk bytes on disk, manifest stale without it.
    const stale = { ...manifest, chunks: manifest.chunks.filter((e) => e.file !== victim.file) };
    saveManifestAtomic(outDir, stale);
    const r = sweep(outDir, { dryRun: false, relayDir });
    assert.ok(r.orphans.includes(victim.file), 'stale-manifest chunk surfaces as orphan');
    assert.ok(r.skippedUnacked.includes(victim.file), 'never-shipped bytes retained');
    assert.deepEqual(r.dictsRemoved, [], 'its dict is not collected while the bytes remain');
    const liveDict = `dict-${dictHex(victim.dictId)}.dict`;
    assert.ok(existsSync(join(outDir, 'dicts', liveDict)), `dict kept: ${liveDict}`);
  });

  it('sweep keeps the dict of a chunk parked in quarantine ahead of repair', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-quar');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    const { manifest } = loadManifest(outDir);
    const victim = manifest.chunks[0];
    assert.ok(victim.dictId !== 0, 'victim chunk needs its dict');
    // Park the chunk (corrupt path), then let a rescan drop it from the
    // manifest while its bytes still await relay repair.
    quarantine(outDir, victim.file);
    const { manifest: parked } = loadManifest(outDir);
    const stale = { ...parked, chunks: parked.chunks.filter((e) => e.file !== victim.file) };
    saveManifestAtomic(outDir, stale);
    const r = sweep(outDir, { dryRun: false, relayDir });
    assert.deepEqual(r.dictsRemoved, [], 'parked bytes keep their dict');
    const liveDict = `dict-${dictHex(victim.dictId)}.dict`;
    assert.ok(existsSync(join(outDir, 'dicts', liveDict)), `dict kept: ${liveDict}`);
  });

  it('merge and cold sweep fail closed below the 50MB reserve', { timeout: 30_000 }, async () => {
    const dir = scratch('gcw-reserve');
    const { hotDb } = writeHotLog(dir, { rows: 1500 });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });

    assert.throws(() => mergeCold(outDir, { freeSpaceBytes: 1024 }), /50MB reserve/, 'merge refuses');
    let segs: string[] = [];
    try { segs = readdirSync(join(outDir, 'cold')); } catch { /* no cold dir: nothing written */ }
    assert.equal(segs.length, 0, 'refused merge writes no segment');

    const m = mergeCold(outDir);
    assert.ok(m.segment, 'merge succeeds with space');
    const before = readFileSync(join(outDir, 'cold', m.segment));
    assert.throws(
      () => sweepCold(outDir, { dryRun: false, freeSpaceBytes: 1024 }),
      /50MB reserve/,
      'cold sweep refuses',
    );
    assert.deepEqual(readFileSync(join(outDir, 'cold', m.segment)), before, 'refused sweep rewrites no tar');
  });
});
