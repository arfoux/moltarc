// manifest waste-fix regressions: seq/crc envelope, best-valid load,
// rebuilt cold[] preservation, bom strip, appendentries fast path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { mergeCold } from '../src/cold.js';
import {
  appendEntries,
  assertShardPointersSize,
  buildManifest,
  loadManifest,
  manifestCrc,
  saveManifestAtomic,
  stripBom,
} from '../src/manifest.js';
import type { Manifest, ShardPointer } from '../src/manifest.js';
import { clearFindCaches, findTrx } from '../src/find.js';
import { scratch, writeHotLog } from './util.js';

async function sealedArchive(name: string, rows = 800): Promise<{ dir: string; outDir: string }> {
  const dir = scratch(name);
  const { hotDb } = writeHotLog(dir, { rows, uniqueBodies: true });
  const outDir = join(dir, 'archive');
  await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
  return { dir, outDir };
}

function readJson(outDir: string, name: string): Manifest {
  return JSON.parse(stripBom(readFileSync(join(outDir, name), 'utf8'))) as Manifest;
}

describe('manifest waste-fix', () => {
  it('generation stamps a seq+crc envelope and every save bumps seq', { timeout: 30_000 }, async () => {
    const { outDir } = await sealedArchive('waste-seq');
    const primary = readJson(outDir, 'manifest.json');
    assert.equal(typeof primary.seq, 'number');
    assert.ok((primary.seq as number) >= 1, 'first save stamps seq >= 1');
    assert.equal(primary.crc32c, manifestCrc(primary), 'stored crc matches envelope');

    const before = primary.seq as number;
    const m = loadManifest(outDir).manifest;
    saveManifestAtomic(outDir, m);
    const after = readJson(outDir, 'manifest.json');
    assert.equal(after.seq, before + 1, 'resave bumps seq by one');
    assert.equal(after.crc32c, manifestCrc(after));
    assert.deepEqual(
      readJson(outDir, 'manifest.bak.json'),
      after,
      'dual copies stay identical',
    );
  });

  it('load picks the best crc-valid copy, never primary-blind', { timeout: 30_000 }, async () => {
    const { outDir } = await sealedArchive('waste-best');
    // Divergent copies: backup one generation newer, both crc-valid.
    const primary = readJson(outDir, 'manifest.json');
    const backup = { ...primary, seq: (primary.seq as number) + 1 };
    backup.crc32c = manifestCrc(backup);
    writeFileSync(join(outDir, 'manifest.bak.json'), `${JSON.stringify(backup, null, 1)}\n`);
    assert.equal(loadManifest(outDir).source, 'backup', 'newer valid backup beats older primary');

    // Torn primary (crc no longer matches) falls back to the valid backup.
    const torn = readFileSync(join(outDir, 'manifest.json'), 'utf8').replace(/"rows": \d+/, '"rows": 999999');
    writeFileSync(join(outDir, 'manifest.json'), torn);
    const viaBackup = loadManifest(outDir);
    assert.equal(viaBackup.source, 'backup');
    assert.equal(viaBackup.manifest.seq, backup.seq);

    // Torn backup too, but with a valid crc under a tampered payload, is rejected.
    const evil = { ...backup, seq: (backup.seq as number) + 5, crc32c: backup.crc32c };
    writeFileSync(join(outDir, 'manifest.bak.json'), `${JSON.stringify(evil, null, 1)}\n`);
    const rebuilt = loadManifest(outDir);
    assert.equal(rebuilt.source, 'rebuilt', 'crc-mismatched tamper is not trusted');
    assert.ok(rebuilt.manifest.chunks.length >= 1);
  });

  it('rebuilt path preserves cold[] salvaged from torn copies', { timeout: 30_000 }, async () => {
    const { outDir } = await sealedArchive('waste-cold', 1500);
    const merged = mergeCold(outDir);
    assert.ok(merged.chunks.length >= 1, 'merge packs a cold segment first');
    const pre = loadManifest(outDir).manifest;
    assert.equal(pre.cold?.length, 1);

    writeFileSync(join(outDir, 'manifest.json'), 'garbage{{{');
    writeFileSync(join(outDir, 'manifest.bak.json'), 'garbage{{{');
    // Torn copies with garbage carry no listing; plant one torn-but-json copy
    // holding the cold listing to prove salvage (torn chunks, good cold).
    const tornCold = { version: 1, createdAt: pre.createdAt, chunks: 'torn', cold: pre.cold, seq: 99, crc32c: 1 };
    writeFileSync(join(outDir, 'manifest.bak.json'), JSON.stringify(tornCold));

    const { manifest, source } = loadManifest(outDir);
    assert.equal(source, 'rebuilt');
    assert.deepEqual(manifest.cold, pre.cold, 'cold listing survives the rescan');
    assert.ok(manifest.chunks.length >= 1, 'warm chunks rediscovered');
    assert.equal(manifest.crc32c, manifestCrc(manifest), 'rebuilt copy is crc-valid');
  });

  it('bom-prefixed manifest copies still parse', { timeout: 30_000 }, async () => {
    const { outDir } = await sealedArchive('waste-bom');
    const expected = loadManifest(outDir).manifest.chunks.length;
    for (const name of ['manifest.json', 'manifest.bak.json']) {
      const raw = readFileSync(join(outDir, name), 'utf8');
      writeFileSync(join(outDir, name), String.fromCharCode(65279) + raw);
    }
    const { manifest, source } = loadManifest(outDir);
    assert.equal(source, 'primary');
    assert.equal(manifest.chunks.length, expected);
  });

  it('appendentries merges without a warm rescan', { timeout: 30_000 }, async () => {
    const { outDir } = await sealedArchive('waste-append');
    const before = loadManifest(outDir).manifest;
    const warmFiles = readdirSync(join(outDir, 'warm')).sort();
    const seqBefore = before.seq as number;

    const template = before.chunks[0];
    const fresh = { ...template, file: 'events-99999991-99999999-deadbeef.chk', seqMin: 99999991, seqMax: 99999999 };
    const merged = appendEntries(outDir, [fresh, template]);
    assert.ok(merged.chunks.some((e) => e.file === fresh.file), 'new entry appended');
    assert.equal(
      merged.chunks.filter((e) => e.file === template.file).length,
      1,
      'existing filename dedupes on retry',
    );
    assert.deepEqual(readdirSync(join(outDir, 'warm')).sort(), warmFiles, 'no rescan, no new chunk bytes');
    assert.equal(merged.seq, seqBefore + 1, 'append bumps the generation');
    assert.equal(merged.crc32c, manifestCrc(merged));

    // A filename-only rebuild would drop the appended row; the saved copy keeps it.
    const reloaded = loadManifest(outDir).manifest;
    assert.ok(reloaded.chunks.some((e) => e.file === fresh.file));
    assert.deepEqual(readJson(outDir, 'manifest.bak.json'), readJson(outDir, 'manifest.json'));

    // buildmanifest alone never resurrects it: proves append went through the copy, not disk.
    const scanned = buildManifest(outDir);
    assert.ok(!scanned.chunks.some((e) => e.file === fresh.file));
  });
});

describe('manifest shard pointers', () => {
  async function multiMonthArchive(name: string): Promise<{ dir: string; outDir: string; ids: string[] }> {
    const dir = scratch(name);
    // 3-day row steps spread chunks across distinct UTC months; 600 rows pass
    // seal's 100-row probe cadence so targetBytes actually splits chunks.
    const { hotDb, ids } = writeHotLog(dir, { rows: 600, uniqueBodies: true, tsStepMs: 3 * 86400 * 1000 });
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir, targetBytes: 2 * 1024 });
    assert.ok(r.chunks.length >= 2, `need >=2 chunks, got ${r.chunks.length}`);
    return { dir, outDir, ids };
  }

  it('stamps per-month pointers; root keeps chunks; pointers fit 2KB', { timeout: 30_000 }, async () => {
    const { outDir } = await multiMonthArchive('waste-pointers');
    const m = loadManifest(outDir).manifest;
    assert.ok(Array.isArray(m.pointers) && m.pointers.length >= 2, `need >=2 pointers, got ${m.pointers?.length}`);
    // Root keeps every chunk; pointer counts partition them (additive only).
    assert.equal(m.pointers.reduce((n, p) => n + p.count, 0), m.chunks.length);
    for (const p of m.pointers) {
      assert.match(p.name, /^\d{4}-\d{2}$/, `month key ${p.name}`);
      assert.equal(p.file, `manifest-${p.name}.json`);
      assert.ok(p.count >= 1, `${p.name} covers at least one chunk`);
      assert.ok(p.minKey === '' || p.minKey <= p.maxKey, `${p.name} key range ordered`);
      assert.ok(p.minTs <= p.maxTs, `${p.name} ts range ordered`);
      assert.equal(typeof p.crc32c, 'number');
      assert.ok(existsSync(join(outDir, p.file)), `sidecar ${p.file} on disk`);
    }
    assert.deepEqual(m.shards, m.pointers.map((p) => p.name), 'month list matches pointer names');
    assertShardPointersSize(m.pointers);
    const bloated: ShardPointer[] = Array.from({ length: 400 }, (_, i) => ({
      name: `20${String(10 + (i % 80)).padStart(2, '0')}-${String(1 + (i % 12)).padStart(2, '0')}`,
      file: `manifest-x-${i}.json`,
      count: 1, minKey: 'a', maxKey: 'z', minTs: 1, maxTs: 2, crc32c: 3,
    }));
    assert.throws(() => assertShardPointersSize(bloated), /2048/, 'oversized pointer list throws');
    // Additive: a resave without changes keeps every stamped month.
    const months = m.shards?.length ?? 0;
    saveManifestAtomic(outDir, loadManifest(outDir).manifest);
    assert.equal(loadManifest(outDir).manifest.shards?.length, months, 'resave never drops months');
  });

  it('find prunes via pointers to exactly 1 shard month; missing shard falls back to root', { timeout: 30_000 }, async () => {
    const { outDir, ids } = await multiMonthArchive('waste-pointer-prune');
    const target = ids[Math.floor(ids.length / 2)];
    clearFindCaches();
    const hit = findTrx({ outDir, trxId: target });
    assert.equal(hit.row.id, target);
    assert.equal(hit.shardsLoaded, 1, 'pointer prune loads exactly the owning month');
    assert.ok((hit.shardsPruned ?? 0) >= 1, `pruned ${(hit.shardsPruned ?? 0)} other month(s)`);
    // Delete the sidecar owning the target month: root fallback still finds it.
    const mp = loadManifest(outDir).manifest;
    const owner = mp.pointers?.find((p) => p.minKey !== '' && p.minKey <= target && target <= p.maxKey);
    assert.ok(owner, 'a pointer owns the target key');
    unlinkSync(join(outDir, owner.file));
    clearFindCaches();
    const fb = findTrx({ outDir, trxId: target });
    assert.equal(fb.row.id, target, 'root fallback finds the row without its shard');
    assert.equal(fb.shardsLoaded, undefined, 'fallback path carries no shard counts');
  });
});
