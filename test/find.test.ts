// find-one-trx: min/max prune + bloom => exactly one chunk fetched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { findTrx, buildSparseIndex, candidates } from '../src/find.js';
import { loadManifest } from '../src/manifest.js';
import { scratch, writeHotLog } from './util.js';

describe('find single chunk', () => {
  it('fetches exactly 1 chunk for a known trx', async () => {
    const dir = scratch('find');
    const { hotDb, ids } = writeHotLog(dir, { rows: 3000, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    assert.ok(r.chunks.length >= 2, `need >=2 chunks, got ${r.chunks.length}`);

    const target = ids[Math.floor(ids.length * 0.7)];
    const { hit, pruned } = candidates(loadManifest(outDir).manifest.chunks, target);
    assert.equal(hit.length, 1);
    assert.ok(pruned >= r.chunks.length - 1);

    const found = findTrx({ outDir, trxId: target });
    assert.equal(found.row.id, target);
    assert.equal(found.chunksFetched, 1);
    assert.equal(found.chunk, hit[0].file);

    const sparse = buildSparseIndex(loadManifest(outDir).manifest.chunks);
    assert.equal(sparse.length, r.chunks.length);

    // Missing key: pruned without a fetch avalanche.
    assert.throws(() => findTrx({ outDir, trxId: 'trx-99999999' }), /not found/);
  });

  it('rebuilds the manifest from filenames when both copies are lost', async () => {
    const dir = scratch('rebuild');
    const { hotDb } = writeHotLog(dir, { rows: 500, uniqueBodies: true });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    writeFileSync(join(outDir, 'manifest.json'), 'garbage');
    writeFileSync(join(outDir, 'manifest.bak.json'), 'garbage');
    const { manifest, source } = loadManifest(outDir);
    assert.equal(source, 'rebuilt');
    assert.ok(manifest.chunks.length >= 1);
  });
});
