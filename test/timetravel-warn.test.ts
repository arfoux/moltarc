// moltarc timetravel missing-chunk warning — deleted warm file still returns rows + warns.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { encodeChunk, type HotRow } from '../src/chunk.js';
import { chunkName } from '../src/seal.js';
import { buildManifest, saveManifestAtomic } from '../src/manifest.js';
import { queryAsOf } from '../src/timetravel.js';
import { scratch } from './util.js';

function row(id: string, seq: number, ts: number, body: string): HotRow {
  return { device_id: 'pos-01', seq, ts, id, table: 'events', body };
}

describe('moltarc timetravel missing-chunk warning', () => {
  it('warns and returns partial rows when a chunk file is missing', { timeout: 30_000 }, () => {
    const dir = scratch('timetravel-warn');
    const outDir = join(dir, 'archive');
    const warm = join(outDir, 'warm');
    mkdirSync(warm, { recursive: true });
    const batches: HotRow[][] = [
      [row('a', 1, 1000, 'a-v1'), row('b', 2, 2000, 'b-v1')],
      [row('b', 3, 3000, 'b-v2'), row('c', 4, 4000, 'c-v1')],
    ];
    const names = batches.map((rows) => {
      const bytes = encodeChunk('events', rows);
      return chunkName('events', rows[0].seq, rows[rows.length - 1].seq, bytes);
    });
    batches.forEach((rows, i) => writeFileSync(join(warm, names[i]), encodeChunk('events', rows)));
    saveManifestAtomic(outDir, buildManifest(outDir));

    rmSync(join(warm, names[1]));

    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      const r = queryAsOf({ outDir, ts: 4500 });
      assert.ok(r.rows.length > 0);
      assert.equal(r.proof.skippedMissing, 1);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warned.length, 1);
    assert.match(warned[0], /timetravel: 1 chunk\(s\) missing, result incomplete/);
  });
});
