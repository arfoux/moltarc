// CLI asof over a holed archive must fail loudly (non-zero), not exit 0 silent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { encodeChunk, type HotRow } from '../src/chunk.js';
import { chunkName } from '../src/seal.js';
import { buildManifest, saveManifestAtomic } from '../src/manifest.js';
import { scratch } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

const row = (id: string, seq: number, ts: number, body: string): HotRow =>
  ({ device_id: 'dev-01', seq, ts, id, table: 'events', body });

describe('cli asof partial', () => {
  it('exits non-zero with a hard PARTIAL warning on a holed archive', { timeout: 30_000 }, () => {
    const dir = scratch('asof-partial');
    const outDir = join(dir, 'archive');
    mkdirSync(join(outDir, 'warm'), { recursive: true });
    const batches: HotRow[][] = [
      [row('a', 1, 1000, 'a-v1')],
      [row('a', 2, 2000, 'a-v2')],
    ];
    const names = batches.map((rows) => {
      const bytes = encodeChunk('events', rows);
      return chunkName('events', rows[0].seq, rows[rows.length - 1].seq, bytes);
    });
    batches.forEach((rows, i) => writeFileSync(join(outDir, 'warm', names[i]), encodeChunk('events', rows)));
    saveManifestAtomic(outDir, buildManifest(outDir));
    rmSync(join(outDir, 'warm', names[0])); // punch the hole
    assert.throws(
      () => execFileSync(process.execPath, [cli, 'asof', outDir, '3000'], { encoding: 'utf8', timeout: 60_000 }),
      (e: unknown) => {
        const err = e as { status?: number; stderr?: string; message?: string };
        const out = `${err.stderr ?? ''}\n${err.message ?? ''}`;
        assert.notEqual(err.status, 0);
        assert.match(out, /PARTIAL/i);
        return true;
      },
    );
  });
});
