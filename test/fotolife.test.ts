// fotolife: foto lifecycle across ship lanes + cold tar/report honesty.
// (1) readTar verifies the ustar checksum field and fails at tar level.
// (2) foto-table chunks ride the blob opt-in lane (deferred unless includeBlobs).
// (3) cold-side sweep/report censes the foto/ dir (report-only; gc deepFoto owns deletes).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { laneOf, planShipment, ship } from '../src/ship.js';
import { loadManifest, type ChunkEntry } from '../src/manifest.js';
import { coldDiskBytes, mergeCold, readTar, sweepCold, writeTar } from '../src/cold.js';
import { scratch, writeHotLog } from './util.js';

function chunkEntry(over: Partial<ChunkEntry> & { file: string; table: string; sha256: string }): ChunkEntry {
  return {
    seqMin: 1, seqMax: 1, tsMin: 1, tsMax: 1, rows: 1, bytes: 100,
    crc32c: 0, dictId: 0, codec: 0, minKey: '', maxKey: '', bloom: '',
    ...over,
  };
}

describe('fotolife', () => {
  it('readTar rejects a header with a broken ustar checksum at tar level', { timeout: 30_000 }, () => {
    const members = [{ name: 'sales-000001-000001-abc123.chk', data: Buffer.from('sealed-bytes') }];
    const good = writeTar(members);
    assert.deepEqual(readTar(good).map((m) => m.name), [members[0].name], 'round-trip intact');
    const bad = Buffer.from(good);
    bad[0] ^= 0x01; // corrupt a name byte: name shifts AND the checksum breaks
    assert.throws(() => readTar(bad), /checksum mismatch/, 'checksum failure throws from readTar, never reaches chunk decode');
  });

  it('sweepCold reports checksum-corrupted segments as corrupt, never reclaimed', { timeout: 30_000 }, async () => {
    const dir = scratch('fotolife-corrupt');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const merged = mergeCold(outDir);
    assert.ok(merged.segment.endsWith('.tar'));
    const segPath = join(outDir, 'cold', merged.segment);
    const size = statSync(segPath).size;
    const raw = readFileSync(segPath);
    raw[0] ^= 0x01; // break the first header checksum on disk
    writeFileSync(segPath, raw);

    const r = sweepCold(outDir); // dry-run default
    assert.deepEqual(r.corrupt, [merged.segment], 'checksum-corrupt segment reported');
    assert.deepEqual(r.pruned, [], 'corrupt segment never pruned');
    assert.deepEqual(r.repacked, [], 'corrupt segment never repacked');
    assert.equal(r.bytesCorrupt, size, 'corrupt bytes counted separately');
    assert.equal(r.bytesReclaimed, 0, 'corrupt bytes never counted as reclaimed');
    assert.ok(existsSync(segPath), 'corrupt segment left on disk');
  });

  it('foto-table chunks ride the blob opt-in lane', { timeout: 30_000 }, () => {
    const foto = chunkEntry({ file: 'foto-000001-000001-deadbeef.chk', table: 'foto', sha256: 'a'.repeat(64) });
    const text = chunkEntry({ file: 'sales-000001-000001-cafe0001.chk', table: 'sales', sha256: 'b'.repeat(64) });
    assert.equal(laneOf(foto), 1, 'foto is a blob-lane table');
    assert.equal(laneOf(text), 0, 'text stays lane 0');

    const deferred = planShipment([foto, text], { chunks: {} }, false);
    assert.deepEqual(deferred.missing.map((e) => e.file), [text.file], 'default plan ships text only');
    assert.ok(
      deferred.skipped.some((s) => s.file === foto.file && s.reason === 'blob-deferred'),
      'foto chunk deferred without opt-in',
    );

    const optIn = planShipment([foto, text], { chunks: {} }, true);
    assert.deepEqual(optIn.missing.map((e) => e.file), [text.file, foto.file], 'opt-in ships text first, foto after');
  });

  it('default ship defers foto chunks; includeBlobs ships them', { timeout: 30_000 }, async () => {
    const dir = scratch('fotolife-shiplane');
    const hot = join(dir, 'hot.jsonl');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    writeFileSync(hot, `${JSON.stringify({ device_id: 'cam-01', seq: 1, ts: 1_700_000_000_000, id: 'foto-only-1', table: 'foto', body: 'small foto caption, inline text' })}\n`);
    await seal({ hotDb: hot, outDir });
    const { manifest } = loadManifest(outDir);
    assert.equal(manifest.chunks.length, 1);
    assert.equal(manifest.chunks[0].table, 'foto');

    const d = await ship({ outDir, relayDir, baseDelayMs: 1 });
    assert.deepEqual(d.sent, [], 'default ship sends no foto chunk');
    assert.ok(d.skipped.includes(manifest.chunks[0].file), 'foto chunk skipped without opt-in');

    const o = await ship({ outDir, relayDir, includeBlobs: true, baseDelayMs: 1 });
    assert.ok(o.sent.includes(manifest.chunks[0].file), 'opt-in ship sends the foto chunk');
  });

  it('cold sweep and disk report include the foto/ dir without deleting it', { timeout: 60_000 }, async () => {
    const dir = scratch('fotolife-coldreport');
    const hot = join(dir, 'hot.jsonl');
    const outDir = join(dir, 'archive');
    const body = randomBytes(300 * 1024).toString('base64');
    writeFileSync(hot, `${JSON.stringify({ device_id: 'cam-01', seq: 1, ts: 1_700_000_000_000, id: 'big-foto-1', table: 'foto', body })}\n`);
    await seal({ hotDb: hot, outDir });
    const sidecars = readdirSync(join(outDir, 'foto')).filter((f) => f.endsWith('.bin'));
    assert.equal(sidecars.length, 1, 'big foto seals to exactly one sidecar');
    mergeCold(outDir);

    const r = sweepCold(outDir);
    assert.ok(r.fotoFiles >= 1, 'sweep reports foto files');
    assert.ok(r.fotoBytes > 0, 'sweep reports foto bytes');
    const disk = coldDiskBytes(outDir);
    assert.ok(disk.fotoFiles >= 1, 'disk report counts foto files');
    assert.equal(disk.fotoBytes, r.fotoBytes, 'sweep and disk report agree on foto bytes');
    assert.ok(existsSync(join(outDir, 'foto', sidecars[0])), 'report-only: sweep never deletes foto bytes');
  });
});
