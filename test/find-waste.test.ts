// find waste-fix regressions: manifest/dict cache, sparse-index jumps,
// findCold tar scan, skippedMissing count, scaled bloom readability.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { mergeCold } from '../src/cold.js';
import { buildBloom } from '../src/manifest.js';
import { fnv1a32 } from '../src/chunk.js';
import {
  bloomBitsForRows,
  bloomCheckScaled,
  buildSparseIndex,
  candidates,
  clearFindCaches,
  findCold,
  findTrx,
} from '../src/find.js';
import { scratch, writeHotLog } from './util.js';

function hashN(seed: number, key: string): number {
  return (fnv1a32(`${seed}:${key}`) ^ fnv1a32(key.split('').reverse().join(''))) >>> 0;
}

function buildBloomSized(ids: string[], bits: number): string {
  const buf = Buffer.alloc(bits / 8);
  for (const id of ids) {
    for (let k = 0; k < 3; k++) {
      const bit = hashN(k, id) % bits;
      buf[bit >> 3] |= 1 << (bit & 7);
    }
  }
  return buf.toString('base64');
}

describe('find waste fixes', () => {
  it('serves repeat queries from cache and survives a cache clear', { timeout: 30_000 }, async () => {
    const dir = scratch('find-cache');
    const { hotDb, ids } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    const target = ids[Math.floor(ids.length * 0.7)];
    const a = findTrx({ outDir, trxId: target });
    const b = findTrx({ outDir, trxId: target });
    assert.equal(b.row.id, target);
    assert.equal(b.chunk, a.chunk);
    assert.equal(b.chunksFetched, 1);
    assert.equal(b.skippedMissing, 0);
    clearFindCaches();
    const c = findTrx({ outDir, trxId: target });
    assert.equal(c.row.id, target);
    assert.equal(c.chunk, a.chunk);
  });

  it('prunes via the sparse index jump and keeps unknown ranges fetchable', { timeout: 30_000 }, () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      file: `events-${String(i).padStart(4, '0')}.chk`,
      table: 'events',
      seqMin: i * 100, seqMax: i * 100 + 99,
      tsMin: 0, tsMax: 0, rows: 100, bytes: 1000,
      sha256: 'x', crc32c: 0, dictId: 0, codec: 1,
      minKey: `trx-${String(i * 100 + 1).padStart(8, '0')}`,
      maxKey: `trx-${String(i * 100 + 100).padStart(8, '0')}`,
      bloom: buildBloom([`trx-${String(i * 100 + 50).padStart(8, '0')}`]),
    }));
    const sparse = buildSparseIndex(entries);
    assert.equal(sparse.length, 10);
    const { hit, pruned } = candidates(entries, `trx-${String(9 * 100 + 50).padStart(8, '0')}`);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].file, entries[9].file);
    assert.equal(pruned, 9);
    // Unknown range (empty min/max): cannot prune, still a candidate.
    const withUnknown = [...entries, {
      file: 'events-unknown.chk', table: 'events',
      seqMin: 0, seqMax: 0, tsMin: 0, tsMax: 0, rows: 0, bytes: 10,
      sha256: 'y', crc32c: 0, dictId: 0, codec: 1, minKey: '', maxKey: '', bloom: '',
    }];
    const r2 = candidates(withUnknown, 'trx-00000001');
    assert.ok(r2.hit.some((e) => e.file === 'events-unknown.chk'));
  });

  it('findCold scans tar members after the warm file is gone, with a cost warning', { timeout: 60_000 }, async () => {
    const dir = scratch('find-cold');
    const { hotDb, ids } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    const merged = mergeCold(outDir);
    assert.ok(merged.segment, 'expected a cold segment');
    clearFindCaches();
    const target = ids[Math.floor(ids.length * 0.7)];
    const warmHit = findTrx({ outDir, trxId: target });
    unlinkSync(join(outDir, 'warm', warmHit.chunk)); // tar is now the only copy
    clearFindCaches();
    assert.throws(() => findTrx({ outDir, trxId: target }), /missing/);
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    try {
      const found = findCold({ outDir, trxId: target });
      assert.equal(found.row.id, target);
      assert.equal(found.chunk, warmHit.chunk);
    } finally {
      console.warn = orig;
    }
    assert.ok(warnings.some((w) => /cold segment/.test(w)), `expected cost warning, got ${warnings.join('; ')}`);
    assert.throws(() => findCold({ outDir, trxId: 'trx-99999999' }), /not found in cold/);
  });

  it('counts missing chunk files instead of silently skipping', { timeout: 30_000 }, async () => {
    const dir = scratch('find-missing');
    const { hotDb, ids } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    const target = ids[Math.floor(ids.length * 0.7)];
    const found = findTrx({ outDir, trxId: target });
    assert.equal(found.skippedMissing, 0);
    unlinkSync(join(outDir, 'warm', found.chunk));
    clearFindCaches();
    assert.throws(() => findTrx({ outDir, trxId: target }), /1 missing/);
  });

  it('scales bloom bits with rows and still reads legacy blooms', { timeout: 30_000 }, () => {
    assert.equal(bloomBitsForRows(10), 2048);
    assert.equal(bloomBitsForRows(2048), 32768);
    const big = bloomBitsForRows(10_000);
    assert.ok(big > 2048 && (big & (big - 1)) === 0, `expected pow2 growth, got ${big}`);
    // Legacy entries stay readable through the scaled check.
    const legacy = buildBloom(['trx-00000001', 'trx-00000002']);
    assert.equal(bloomCheckScaled(legacy, 'trx-00000001'), true);
    assert.equal(bloomCheckScaled(legacy, 'trx-99999999'), false);
    // Scaled entry: definite member found, far key rejected (no false negative).
    const scaled = buildBloomSized(['trx-00000001'], 8192);
    assert.equal(Buffer.from(scaled, 'base64').length, 1024);
    assert.equal(bloomCheckScaled(scaled, 'trx-00000001'), true);
    assert.equal(bloomCheckScaled(scaled, 'zzz-no-such-key-999'), false);
    assert.equal(bloomCheckScaled('', 'anything'), true);
  });
});
