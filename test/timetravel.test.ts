// moltarc timetravel test — fixed 3-chunk archive, 3 timestamps, exact rows.
// Fixture is deterministic (encodeChunk directly, no seal clock dependence).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { encodeChunk, type HotRow } from '../src/chunk.js';
import { chunkName } from '../src/seal.js';
import { buildManifest, saveManifestAtomic } from '../src/manifest.js';
import { queryAsOf } from '../src/timetravel.js';
import { scratch } from './util.js';

function row(id: string, seq: number, ts: number, body: string): HotRow {
  return { device_id: 'dev-01', seq, ts, id, table: 'events', body };
}

function fixedArchive(): { outDir: string; names: string[] } {
  const dir = scratch('timetravel');
  const outDir = join(dir, 'archive');
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const batches: HotRow[][] = [
    [row('a', 1, 1000, 'a-v1'), row('b', 2, 2000, 'b-v1'), row('c', 3, 3000, 'c-v1')],
    [row('b', 4, 4000, 'b-v2'), row('d', 5, 5000, 'd-v1')],
    [row('a', 6, 6000, 'a-v2')],
  ];
  // Fixture names carry the real content hash: chunkName over the exact
  // bytes on disk, so filename-link checks see honest events-seq-sha8 names.
  const names = batches.map((rows) => {
    const bytes = encodeChunk('events', rows);
    return chunkName('events', rows[0].seq, rows[rows.length - 1].seq, bytes);
  });
  batches.forEach((rows, i) => writeFileSync(join(warm, names[i]), encodeChunk('events', rows)));
  saveManifestAtomic(outDir, buildManifest(outDir));
  return { outDir, names };
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
    const { outDir, names } = fixedArchive();
    const before = snapshot(outDir);
    const r = queryAsOf({ outDir, ts: 2500 });
    assert.deepEqual(byId(r.rows), { a: '1:1000:a-v1', b: '2:2000:b-v1' });
    assert.deepEqual(r.proof.chunksConsulted, [names[0]]);
    assert.equal(r.proof.chunksPruned, 2);
    assert.equal(snapshot(outDir), before);
  });

  it('as-of ts 4500 folds b update, d not yet visible', { timeout: 30_000 }, () => {
    const { outDir, names } = fixedArchive();
    const r = queryAsOf({ outDir, ts: 4500 });
    assert.deepEqual(byId(r.rows), { a: '1:1000:a-v1', b: '4:4000:b-v2', c: '3:3000:c-v1' });
    assert.deepEqual(r.proof.chunksConsulted, [names[0], names[1]]);
    assert.equal(r.proof.chunksPruned, 1);
  });

  it('as-of ts 6500 sees latest per id across all chunks', { timeout: 30_000 }, () => {
    const { outDir } = fixedArchive();
    const r = queryAsOf({ outDir, ts: 6500 });
    assert.deepEqual(byId(r.rows), {
      a: '6:6000:a-v2', b: '4:4000:b-v2', c: '3:3000:c-v1', d: '5:5000:d-v1',
    });
    assert.equal(r.proof.chunksConsulted.length, 3);
    assert.equal(r.proof.chunksPruned, 0);
  });
});

describe('moltarc timetravel O(k) prune + cap', () => {
  it('as-of seq prunes future chunks by seqMin (O(k) range prune)', { timeout: 30_000 }, () => {
    const { outDir, names } = fixedArchive();
    // seq 2 should see only chunks with seqMin <=2 ; chunk2 seqMin=4 and chunk3 seqMin=6 pruned
    const r = queryAsOf({ outDir, seq: 2 });
    assert.deepEqual(byId(r.rows), { a: '1:1000:a-v1', b: '2:2000:b-v1' });
    assert.equal(r.proof.chunksPruned, 2);
    assert.deepEqual(r.proof.chunksConsulted, [names[0]]);
    // seq 4 should include chunk2 but prune chunk3
    const r2 = queryAsOf({ outDir, seq: 4 });
    assert.equal(r2.proof.chunksConsulted.length, 2);
    assert.equal(r2.proof.chunksPruned, 1);
  });

  it('warns when kept chunks exceed 1000', { timeout: 30_000 }, () => {
    const dir = scratch('timetravel-cap');
    const outDir = join(dir, 'archive');
    const warm = join(outDir, 'warm');
    mkdirSync(warm, { recursive: true });
    // Create 1001 tiny chunks with sequential seq, all with seqMin <= target
    const names: string[] = [];
    for (let i = 0; i < 1001; i++) {
      const seq = i + 1;
      const rows: HotRow[] = [row(`id-${i}`, seq, seq * 1000, `v${seq}`)];
      const bytes = encodeChunk('events', rows);
      const name = chunkName('events', seq, seq, bytes);
      names.push(name);
      writeFileSync(join(warm, name), bytes);
    }
    saveManifestAtomic(outDir, buildManifest(outDir));
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warns.push(String(a[0]));
    try {
      const r = queryAsOf({ outDir, seq: 2000 });
      assert.equal(r.proof.chunksConsulted.length, 1001);
      assert.ok(warns.some((m) => m.includes('exceeds 1000')), `expected cap warning, got ${warns.join('; ')}`);
    } finally {
      console.warn = origWarn;
    }
  });

  it('does not warn when kept <=1000', { timeout: 30_000 }, () => {
    const { outDir } = fixedArchive();
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warns.push(String(a[0]));
    try {
      queryAsOf({ outDir, ts: 6500 });
      assert.equal(warns.filter((m) => m.includes('exceeds 1000')).length, 0);
    } finally {
      console.warn = origWarn;
    }
  });
});
