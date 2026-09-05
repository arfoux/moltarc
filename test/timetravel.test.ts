// moltarc timetravel test — fixed 3-chunk archive, 3 timestamps, exact rows.
// Fixture is deterministic (encodeChunk directly, no seal clock dependence).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { encodeChunk, type HotRow } from '../src/chunk.js';
import { buildManifest, saveManifestAtomic } from '../src/manifest.js';
import { queryAsOf } from '../src/timetravel.js';
import { scratch } from './util.js';

function row(id: string, seq: number, ts: number, body: string): HotRow {
  return { device_id: 'pos-01', seq, ts, id, table: 'sales', body };
}

function fixedArchive(): string {
  const dir = scratch('timetravel');
  const outDir = join(dir, 'archive');
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const chunks: { name: string; rows: HotRow[] }[] = [
    {
      name: 'sales-00000001-00000003-aaaaaaaa.chk',
      rows: [row('a', 1, 1000, 'a-v1'), row('b', 2, 2000, 'b-v1'), row('c', 3, 3000, 'c-v1')],
    },
    {
      name: 'sales-00000004-00000005-bbbbbbbb.chk',
      rows: [row('b', 4, 4000, 'b-v2'), row('d', 5, 5000, 'd-v1')],
    },
    {
      name: 'sales-00000006-00000006-cccccccc.chk',
      rows: [row('a', 6, 6000, 'a-v2')],
    },
  ];
  for (const c of chunks) writeFileSync(join(warm, c.name), encodeChunk('sales', c.rows));
  saveManifestAtomic(outDir, buildManifest(outDir));
  return outDir;
}

function snapshot(outDir: string): string {
  const files = [...readdirSync(join(outDir, 'warm')).sort(), 'manifest.json', 'manifest.bak.json'];
  return files.map((f) => {
    const p = f.endsWith('.json') ? join(outDir, f) : join(outDir, 'warm', f);
    return `${f}:${readFileSync(p).toString('hex').length}`;
  }).join('|');
}

const byId = (rows: HotRow[]) => Object.fromEntries(rows.map((r) => [r.id, `${r.seq}:${r.ts}:${r.body}`]));

describe('moltarc timetravel', () => {
  it('as-of ts 2500 sees only chunk1 versions', { timeout: 30_000 }, () => {
    const outDir = fixedArchive();
    const before = snapshot(outDir);
    const r = queryAsOf({ outDir, ts: 2500 });
    assert.deepEqual(byId(r.rows), { a: '1:1000:a-v1', b: '2:2000:b-v1' });
    assert.deepEqual(r.proof.chunksConsulted, ['sales-00000001-00000003-aaaaaaaa.chk']);
    assert.equal(r.proof.chunksPruned, 2);
    assert.equal(snapshot(outDir), before);
  });

  it('as-of ts 4500 folds b update, d not yet visible', { timeout: 30_000 }, () => {
    const outDir = fixedArchive();
    const r = queryAsOf({ outDir, ts: 4500 });
    assert.deepEqual(byId(r.rows), { a: '1:1000:a-v1', b: '4:4000:b-v2', c: '3:3000:c-v1' });
    assert.deepEqual(r.proof.chunksConsulted, [
      'sales-00000001-00000003-aaaaaaaa.chk',
      'sales-00000004-00000005-bbbbbbbb.chk',
    ]);
    assert.equal(r.proof.chunksPruned, 1);
  });

  it('as-of ts 6500 sees latest per id across all chunks', { timeout: 30_000 }, () => {
    const outDir = fixedArchive();
    const r = queryAsOf({ outDir, ts: 6500 });
    assert.deepEqual(byId(r.rows), {
      a: '6:6000:a-v2', b: '4:4000:b-v2', c: '3:3000:c-v1', d: '5:5000:d-v1',
    });
    assert.equal(r.proof.chunksConsulted.length, 3);
    assert.equal(r.proof.chunksPruned, 0);
  });
});
