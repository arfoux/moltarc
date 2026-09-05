// cold gc end-to-end: seal -> merge warm into cold tar -> forget one chunk
// -> warm sweep -> cold sweep repacks without it, archive shrinks, live rows survive.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { sweep } from '../src/gc.js';
import { forgetChunks, mergeCold, readTar, sweepCold } from '../src/cold.js';
import { loadManifest } from '../src/manifest.js';
import { findTrx } from '../src/find.js';
import { scratch } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'molt.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function archiveBytes(outDir: string): number {
  let total = 0;
  for (const sub of ['warm', 'cold']) {
    const d = join(outDir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      try { total += statSync(join(d, f)).size; } catch { /* raced delete */ }
    }
  }
  return total;
}

// Two tables pack separately, so one seal yields one chunk per table.
function writeTwoTableLog(dir: string, rowsPerTable: number): { hotDb: string; ids: string[] } {
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const ids: string[] = [];
  const base = 1_700_000_000_000;
  let seq = 0;
  for (const table of ['sales', 'notes']) {
    for (let i = 0; i < rowsPerTable; i++) {
      seq++;
      const id = `trx-${String(seq).padStart(8, '0')}`;
      ids.push(id);
      lines.push(JSON.stringify({
        device_id: 'pos-01', seq, ts: base + seq * 1000,
        id, table, body: `row ${i} of ${table} amount=${15000 + (i % 97)} cashier=agus store=jakarta-selatan`,
      }));
    }
  }
  const hotDb = join(dir, 'hot.jsonl');
  writeFileSync(hotDb, `${lines.join('\n')}\n`);
  return { hotDb, ids };
}

describe('cold gc end-to-end', () => {
  it('cold sweep repacks without forgotten chunks and the archive shrinks', async () => {
    const dir = scratch('coldg-e2e');
    const { hotDb } = writeTwoTableLog(dir, 1500);
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    const sealed = await seal({ hotDb, outDir });
    await ship({ outDir, relayDir, baseDelayMs: 1 });

    const merged = mergeCold(outDir);
    assert.ok(merged.segment.endsWith('.tar'), 'one cold segment packed');
    assert.equal(merged.chunks.length, sealed.chunks.length);
    assert.ok(existsSync(join(outDir, 'cold', merged.segment)));
    const members = readTar(readFileSync(join(outDir, 'cold', merged.segment)));
    assert.equal(members.length, sealed.chunks.length);

    // Dry-run default: reports but changes nothing.
    const victim = merged.chunks[0];
    forgetChunks(outDir, [victim], relayDir);
    const { manifest: keptManifest } = loadManifest(outDir);
    assert.ok(keptManifest.chunks.length >= 1, 'one chunk survives');
    const liveId = keptManifest.chunks[0].minKey;
    assert.ok(liveId, 'survivor has a key range');
    const before = archiveBytes(outDir);
    const dry = sweepCold(outDir);
    assert.equal(dry.dryRun, true);
    assert.ok(dry.bytesReclaimed > 0, 'dead member bytes reclaimable');
    assert.equal(archiveBytes(outDir), before, 'dry-run changes nothing');

    // Warm sweep first: the forgotten chunk file is now an orphan.
    const warm = sweep(outDir, { dryRun: false });
    assert.ok(warm.removed.includes(victim), 'warm sweep drops forgotten chunk');
    assert.ok(!existsSync(join(outDir, 'warm', victim)));

    // Cold sweep applies: repack without the dead member, archive shrinks.
    const applied = sweepCold(outDir, { dryRun: false });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.repacked.length, 1);
    assert.equal(applied.pruned.length, 0);
    assert.ok(applied.bytesReclaimed > 0);
    const after = archiveBytes(outDir);
    assert.ok(after < before, `archive shrinks: ${before}B -> ${after}B`);

    // Manifest rewritten atomically: both copies agree, no dead refs left.
    const primary = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    const backup = JSON.parse(readFileSync(join(outDir, 'manifest.bak.json'), 'utf8'));
    assert.deepEqual(primary.chunks, backup.chunks);
    assert.deepEqual(primary.cold, backup.cold);
    const seg = primary.cold.find((s: { file: string }) => s.file === merged.segment);
    assert.ok(seg, 'segment entry kept');
    assert.ok(!seg.chunks.includes(victim), 'dead chunk gone from manifest');
    const kept = readTar(readFileSync(join(outDir, 'cold', merged.segment)));
    assert.ok(!kept.some((m) => m.name === victim), 'dead chunk gone from tar');
    assert.ok(kept.length >= 1, 'live members kept');

    // Live rows still resolve through the manifest.
    const found = findTrx({ outDir, trxId: liveId });
    assert.equal(found.row.id, liveId);
  });

  it('fully-dead segments are pruned and status shows warm vs cold vs orphan bytes', async () => {
    const dir = scratch('coldg-prune');
    const { hotDb } = writeTwoTableLog(dir, 1500);
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const merged = mergeCold(outDir);
    assert.ok(merged.chunks.length >= 1);

    // Forget everything: the whole segment dies.
    forgetChunks(outDir, merged.chunks, relayDir);
    sweep(outDir, { dryRun: false });
    const applied = sweepCold(outDir, { dryRun: false });
    assert.deepEqual(applied.pruned, [merged.segment]);
    assert.ok(!existsSync(join(outDir, 'cold', merged.segment)), 'dead segment deleted');
    const { manifest } = loadManifest(outDir);
    assert.ok(!(manifest.cold ?? []).some((s) => s.file === merged.segment));

    const status = run('status', outDir);
    assert.match(status, /warm: \d+ chunk\(s\), \d+B/);
    assert.match(status, /cold: \d+ segment\(s\), \d+ chunk\(s\), \d+B/);
    assert.match(status, /orphans: \d+ \(\d+B\)/);
    assert.match(status, /cold: 0 segment\(s\), 0 chunk\(s\), 0B/);
  });
});
