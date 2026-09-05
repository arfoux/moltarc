// manifest waste-fix regressions: seq/crc envelope, best-valid load,
// rebuilt cold[] preservation, bom strip, appendentries fast path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { mergeCold } from '../src/cold.js';
import {
  appendEntries,
  buildManifest,
  loadManifest,
  manifestCrc,
  saveManifestAtomic,
  stripBom,
} from '../src/manifest.js';
import type { Manifest } from '../src/manifest.js';
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
    const fresh = { ...template, file: 'sales-99999991-99999999-deadbeef.chk', seqMin: 99999991, seqMax: 99999999 };
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
