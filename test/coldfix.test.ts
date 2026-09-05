// merge-seal-merge keeps cold listing stable; ship reports missing warm as skipped.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { mergeCold, readTar } from '../src/cold.js';
import { loadManifest } from '../src/manifest.js';
import { scratch, writeHotLog } from './util.js';

function appendSeqRows(hotDb: string, fromSeq: number, count: number, device = 'pos-01', table = 'sales'): void {
  const base = 1_700_000_000_000;
  const lines: string[] = [];
  for (let k = 0; k < count; k++) {
    const seq = fromSeq + k;
    lines.push(JSON.stringify({
      device_id: device, seq, ts: base + seq * 1000,
      id: `trx-${String(seq).padStart(8, '0')}`, table,
      body: `TRANSACTION OK amount=15000 cashier=agus seq=${seq} store=jakarta-selatan`,
    }));
  }
  appendFileSync(hotDb, `${lines.join('\n')}\n`);
}

describe('coldfix regressions', () => {
  it('merge-seal-merge keeps cold listing stable with no duplicate chunks', async () => {
    const dir = scratch('coldfix-msm');
    const { hotDb } = writeHotLog(dir, { rows: 1500, table: 'sales' });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const m1 = mergeCold(outDir);
    assert.ok(m1.chunks.length >= 1, 'first merge packs warm chunks');
    const { manifest: pre } = loadManifest(outDir);
    assert.equal(pre.cold?.length, 1, 'one cold segment after first merge');
    const tarBefore = readTar(readFileSync(join(outDir, 'cold', m1.segment))).map((m) => m.name).sort();

    // New rows force a real second seal (the rebuild path that used to wipe cold[]).
    appendSeqRows(hotDb, 1501, 1500);
    await seal({ hotDb, outDir });
    const { manifest: post } = loadManifest(outDir);
    assert.deepEqual(post.cold, pre.cold, 'seal preserves cold listing verbatim');
    assert.ok(existsSync(join(outDir, 'cold', m1.segment)), 'cold tar stays on disk');
    const tarAfter = readTar(readFileSync(join(outDir, 'cold', m1.segment))).map((m) => m.name).sort();
    assert.deepEqual(tarAfter, tarBefore, 'cold tar members untouched by seal');

    // Second merge packs only the new warm chunks, never repacks the old ones.
    const m2 = mergeCold(outDir);
    assert.ok(m2.chunks.length >= 1, 'second merge packs new chunks');
    assert.ok(!m2.chunks.some((c) => m1.chunks.includes(c)), 'no duplicate chunks across merges');
    const { manifest: fin } = loadManifest(outDir);
    assert.equal(fin.cold?.length, 2, 'two cold segments after second merge');
    const all = (fin.cold ?? []).flatMap((s) => s.chunks);
    assert.equal(new Set(all).size, all.length, 'no chunk listed in two segments');
  });

  it('ship reports missing warm sources as skipped with ids', async () => {
    const dir = scratch('coldfix-shipskip');
    const { hotDb } = writeHotLog(dir, { rows: 1500, table: 'sales' });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    appendSeqRows(hotDb, 1501, 1500);
    await seal({ hotDb, outDir });
    const { manifest } = loadManifest(outDir);
    assert.ok(manifest.chunks.length >= 2, 'two warm chunks to split sent vs skipped');

    const victim = manifest.chunks[0].file;
    unlinkSync(join(outDir, 'warm', victim));
    const r = await ship({ outDir, relayDir, baseDelayMs: 1 });
    assert.ok(r.skipped.includes(victim), `skipped names the missing source: ${victim}`);
    assert.ok(!r.sent.includes(victim), 'missing source is never marked sent');
    assert.equal(r.sent.length, manifest.chunks.length - 1, 'survivors still ship');
    assert.equal(r.sent.length + r.skipped.length, manifest.chunks.length, 'every chunk accounted for');
  });
});
