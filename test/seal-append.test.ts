// seal appendentries equivalence: second seal merges via appendEntries and
// matches the full-rebuild listing byte-for-byte on chunk entries.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { buildManifest, loadManifest, manifestCrc } from '../src/manifest.js';
import type { Manifest } from '../src/manifest.js';
import { verifyAll } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

function readJson(outDir: string, name: string): Manifest {
  return JSON.parse(readFileSync(join(outDir, name), 'utf8')) as Manifest;
}

describe('seal appendentries equivalence', () => {
  it('second seal via append matches full rebuild content', { timeout: 60_000 }, async () => {
    const dir = scratch('seal-append-equiv');
    const { hotDb } = writeHotLog(dir, { rows: 1000, uniqueBodies: true });
    const outDir = join(dir, 'arch');

    // First seal: no prior manifest, owns the full-rebuild path.
    const first = await seal({ hotDb, outDir, maxRows: 400, targetBytes: 16 * 1024 });
    assert.equal(first.rowsSealed, 400);
    const afterFirst = loadManifest(outDir).manifest;
    const scannedFirst = buildManifest(outDir);
    assert.deepEqual(afterFirst.chunks, scannedFirst.chunks);

    // Second seal: manifest exists, must take the appendEntries fast path.
    const second = await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
    assert.equal(second.rowsSealed, 600);
    assert.ok(second.chunks.length >= 1);

    const live = loadManifest(outDir).manifest;
    const rebuilt = buildManifest(outDir);
    assert.deepEqual(live.chunks, rebuilt.chunks);
    assert.deepEqual(
      live.chunks.map((c) => c.file),
      [...live.chunks.map((c) => c.file)].sort(),
      'chunk ordering stays filename-sorted',
    );
    assert.equal(live.crc32c, manifestCrc(live));
    assert.deepEqual(readJson(outDir, 'manifest.bak.json'), readJson(outDir, 'manifest.json'));
    assert.ok(verifyAll(outDir).ok);
  });
});
