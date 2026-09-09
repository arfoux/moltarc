// merge-seal-merge keeps cold listing stable; ship reports missing warm as skipped.
// merge packs dictless chunks without demanding phantom dict files.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { decodeHeader, DICT_FLAG } from '../src/chunk.js';
import { dictHex } from '../src/dict.js';
import { sweep } from '../src/gc.js';
import { findTrx } from '../src/find.js';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { mergeCold, readTar } from '../src/cold.js';
import { loadManifest } from '../src/manifest.js';
import { scratch, writeHotLog } from './util.js';

function appendSeqRows(hotDb: string, fromSeq: number, count: number, device = 'pos-01', table = 'events'): void {
  const base = 1_700_000_000_000;
  const lines: string[] = [];
  for (let k = 0; k < count; k++) {
    const seq = fromSeq + k;
    lines.push(JSON.stringify({
      device_id: device, seq, ts: base + seq * 1000,
      id: `trx-${String(seq).padStart(8, '0')}`, table,
      body: `TRANSACTION OK value=15000 cashier=agus seq=${seq} store=jakarta-selatan`,
    }));
  }
  appendFileSync(hotDb, `${lines.join('\n')}\n`);
}

describe('coldfix regressions', () => {
  it('merge-seal-merge keeps cold listing stable with no duplicate chunks', { timeout: 30_000 }, async () => {
    const dir = scratch('coldfix-msm');
    const { hotDb } = writeHotLog(dir, { rows: 1500, table: 'events' });
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

  it('ship reports missing warm sources as skipped with ids', { timeout: 30_000 }, async () => {
    const dir = scratch('coldfix-shipskip');
    const { hotDb } = writeHotLog(dir, { rows: 1500, table: 'events' });
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

  it('merge packs dictless chunks without demanding phantom dict files', { timeout: 60_000 }, async () => {
    const dir = scratch('coldfix-dictless');
    mkdirSync(dir, { recursive: true });
    const outDir = join(dir, 'archive');
    // events: repetitive bodies earn a trained dict; photo: unique bodies earn none.
    // Both tables seal dictId-tagged headers, but only DICT_FLAG chunks need a file.
    const base = 1_700_000_000_000;
    // Deterministic PRNG: photo hashes must be unique and incompressible
    // (counter hex still compresses 4x and earns a dict, hiding the bug).
    let st = 0x12345678;
    const hex64 = (): string => {
      let s = '';
      for (let k = 0; k < 16; k++) {
        st = (Math.imul(st ^ (st >>> 15), 1 | st) + 0x6d2b79f5) | 0;
        s += ((st >>> 0).toString(16).padStart(8, '0'));
      }
      return s.slice(0, 64);
    };
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(JSON.stringify({
        device_id: 'pos-01', seq: i + 1, ts: base + i * 1000,
        id: `trx-${String(i + 1).padStart(8, '0')}`, table: 'events',
        body: `TRANSACTION OK value=${15000 + (i % 97)} cashier=agus tend=cash change=0 store=jakarta-selatan`,
      }));
    }
    for (let i = 0; i < 1500; i++) {
      lines.push(JSON.stringify({
        device_id: 'cam-01', seq: i + 1, ts: base + (1500 + i) * 1000,
        id: `photo-${String(i + 1).padStart(8, '0')}`, table: 'photo',
        body: `blob:sha256:${hex64()}:size=4096`,
      }));
    }
    const hotDb = join(dir, 'hot.jsonl');
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    await seal({ hotDb, outDir, targetBytes: 4 * 1024 });
    const { manifest } = loadManifest(outDir);
    assert.ok(manifest.chunks.length >= 3, `need dict + dictless chunks, got ${manifest.chunks.length}`);
    const dictsOnDisk = new Set(readdirSync(join(outDir, 'dicts')));
    let flagged = 0;
    let hintOnly = 0;
    for (const e of manifest.chunks) {
      const h = decodeHeader(readFileSync(join(outDir, 'warm', e.file)));
      assert.equal(h.dictId >>> 0, e.dictId >>> 0, 'manifest dictId matches header');
      if ((h.flags & DICT_FLAG) !== 0) {
        flagged++;
        assert.ok(dictsOnDisk.has(`dict-${dictHex(e.dictId >>> 0)}.dict`), `trained dict present for ${e.file}`);
      } else if (e.dictId !== 0) {
        hintOnly++;
        assert.ok(!dictsOnDisk.has(`dict-${dictHex(e.dictId >>> 0)}.dict`), `no dict file for hint-only ${e.file}`);
      }
    }
    assert.ok(flagged >= 1, 'at least one DICT_FLAG chunk sealed');
    assert.ok(hintOnly >= 1, 'at least one hint-only chunk sealed');

    // gc sweep must not orphan the live trained dicts (rule 7: apply needs relay ack).
    const relayDir = join(dir, 'relay');
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const swept = sweep(outDir, { dryRun: false, relayDir });
    assert.deepEqual(swept.dictsRemoved, [], 'sweep removes no live dict');
    for (const e of manifest.chunks) {
      const h = decodeHeader(readFileSync(join(outDir, 'warm', e.file)));
      if ((h.flags & DICT_FLAG) !== 0) assert.ok(existsSync(join(outDir, 'dicts', `dict-${dictHex(e.dictId >>> 0)}.dict`)), `live dict kept for ${e.file}`);
    }

    // merge used to refuse here: hint-only photo chunks named phantom dict files.
    const merged = mergeCold(outDir);
    assert.ok(merged.segment.endsWith('.tar'), 'cold segment written');
    assert.equal(merged.chunks.length, manifest.chunks.length, 'every live chunk merged');
    for (const d of merged.dicts) assert.ok(dictsOnDisk.has(d.split('/')[1]), `packed dict exists: ${d}`);
    const names = new Set(readTar(readFileSync(join(outDir, 'cold', merged.segment))).map((m) => m.name));
    for (const e of manifest.chunks) assert.ok(names.has(e.file), `segment carries ${e.file}`);

    // rows from both sides stay readable after the merge.
    assert.equal(findTrx({ outDir, trxId: 'trx-00000001' }).row.id, 'trx-00000001', 'dict row survives merge');
    assert.equal(findTrx({ outDir, trxId: 'photo-00000001' }).row.id, 'photo-00000001', 'dictless row survives merge');
  });
});
