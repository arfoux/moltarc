// cold honesty: corrupt bytes never count as reclaimed; forget says bytes stay until sweep.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { forgetChunks, mergeCold, sweepCold } from '../src/cold.js';
import { loadManifest } from '../src/manifest.js';
import { scratch, writeHotLog } from './util.js';

describe('cold honesty', () => {
  it('corrupt segments get a separate bytesCorrupt counter, never counted as reclaimed', { timeout: 30_000 }, async () => {
    const dir = scratch('coldhonest-corrupt');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const merged = mergeCold(outDir);
    assert.ok(merged.segment.endsWith('.tar'));

    // Corrupt the segment on disk: non-zero garbage fails tar decode loud.
    const segPath = join(outDir, 'cold', merged.segment);
    const size = statSync(segPath).size;
    writeFileSync(segPath, Buffer.alloc(size, 0xab));

    const r = sweepCold(outDir); // dry-run default
    assert.deepEqual(r.corrupt, [merged.segment], 'corrupt segment reported');
    assert.deepEqual(r.pruned, [], 'corrupt segment never pruned');
    assert.deepEqual(r.repacked, [], 'corrupt segment never repacked');
    const rec: unknown = r;
    assert.ok(rec && typeof rec === 'object' && 'bytesCorrupt' in rec, 'result carries bytesCorrupt');
    const bytesCorrupt = rec.bytesCorrupt;
    if (typeof bytesCorrupt !== 'number') throw new Error('bytesCorrupt must be a number');
    assert.equal(bytesCorrupt, size, 'corrupt bytes counted separately');
    assert.equal(r.bytesReclaimed, 0, 'corrupt bytes never counted as reclaimed');
    assert.equal(r.bytesBefore, r.bytesAfter, 'corrupt bytes stay in bytesAfter');
    assert.ok(existsSync(segPath), 'corrupt segment left on disk');
  });

  it('forget says bytes stay until gc + coldg apply', { timeout: 30_000 }, async () => {
    const dir = scratch('coldhonest-forget');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    await seal({ hotDb, outDir });
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const { manifest } = loadManifest(outDir);
    assert.ok(manifest.chunks.length >= 1);
    const victim = manifest.chunks[0].file;

    const r = forgetChunks(outDir, [victim], relayDir);
    assert.deepEqual(r.removed, [victim]);
    const rec: unknown = r;
    assert.ok(rec && typeof rec === 'object' && 'note' in rec, 'forget returns a bytes-stay note');
    const note = rec.note;
    if (typeof note !== 'string') throw new Error('forget note must be a string');
    assert.match(note, /gc.*--apply/, 'note says to run gc --apply');
    assert.match(note, /coldg.*--apply/, 'note says to run coldg --apply');
    assert.match(note, /bytes remain/, 'note says bytes stay');
    assert.ok(existsSync(join(outDir, 'warm', victim)), 'tar bytes stay on disk until sweep');
  });
});
