// timetravel window: recent-state fold prunes old chunks, full fold unchanged.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { encodeChunk, type HotRow } from '../src/chunk.js';
import { chunkName } from '../src/seal.js';
import { buildManifest, saveManifestAtomic } from '../src/manifest.js';
import { queryAsOf } from '../src/timetravel.js';
import { verifyFull } from '../src/verify.js';
import { scratch } from './util.js';

function row(id: string, seq: number, ts: number, body: string): HotRow {
  return { device_id: 'pos-01', seq, ts, id, table: 'events', body };
}

function windowArchive(): string {
  const dir = scratch('travel-window');
  const outDir = join(dir, 'archive');
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const groups: HotRow[][] = [
    [row('a', 1, 1000, 'a-v1'), row('b', 2, 2000, 'b-v1'), row('c', 3, 3000, 'c-v1')],
    [row('b', 4, 4000, 'b-v2'), row('d', 5, 5000, 'd-v1')],
    [row('a', 6, 6000, 'a-v2')],
  ];
  for (const rows of groups) {
    const buf = encodeChunk('events', rows);
    const seqs = rows.map((r) => r.seq);
    const name = chunkName('events', Math.min(...seqs), Math.max(...seqs), buf);
    writeFileSync(join(warm, name), buf);
  }
  saveManifestAtomic(outDir, buildManifest(outDir));
  return outDir;
}

describe('timetravel window', () => {
  it('windowed fold sees only in-window ids', { timeout: 30_000 }, () => {
    const outDir = windowArchive();
    assert.ok(verifyFull(outDir).ok, 'fixture itself verifies clean (real chunk names)');
    const full = queryAsOf({ outDir, ts: 6500 });
    assert.equal(full.rows.length, 4);
    assert.equal(full.proof.windowed, false);
    const win = queryAsOf({ outDir, ts: 6500, windowMs: 2000 });
    const ids = Object.fromEntries(win.rows.map((r) => [r.id, r.body]));
    assert.deepEqual(ids, { a: 'a-v2', d: 'd-v1' });
    assert.equal(win.proof.windowed, true);
    assert.ok(win.proof.chunksConsulted.length <= full.proof.chunksConsulted.length);
  });

  it('window mismatch modes throw', { timeout: 30_000 }, () => {
    const outDir = windowArchive();
    assert.throws(() => queryAsOf({ outDir, ts: 100, windowSeq: 5 }), /windowSeq needs seq/);
    assert.throws(() => queryAsOf({ outDir, seq: 5, windowMs: 5 }), /windowMs needs ts/);
    assert.throws(() => queryAsOf({ outDir, ts: 100, windowMs: -1 }), /windowMs/);
  });

  it('seq window prunes old chunks', { timeout: 30_000 }, () => {
    const outDir = windowArchive();
    const win = queryAsOf({ outDir, seq: 6, windowSeq: 2 });
    const ids = win.rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ['a', 'd']);
    assert.equal(win.proof.windowed, true);
  });
});
