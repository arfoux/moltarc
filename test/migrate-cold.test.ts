// Regression: migrate rescans warm chunks into a fresh manifest, but the
// prior cold[] listing must survive that rebuild or every cold segment ref
// is silently dropped (tar bytes stay on disk, refs disappear).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { encodeChunk, type HotRow } from '../src/chunk.js';
import { buildManifest, loadManifest, manifestCrc } from '../src/manifest.js';
import { migrate, planMigration } from '../src/migrate.js';
import { scratch } from './util.js';

describe('migrate preserves cold segment refs', () => {
  it('keeps cold[] from the pre-migrate manifest across the warm rescan', { timeout: 30_000 }, () => {
    const root = scratch('migrate-cold');
    const outDir = join(root, 'arc');
    const warm = join(outDir, 'warm');
    mkdirSync(warm, { recursive: true });

    const rows: HotRow[] = [1, 2].map((seq) => ({
      device_id: 'dev-01', seq, ts: 1_700_000_000_000 + seq * 1000,
      id: `trx-${String(seq).padStart(8, '0')}`, table: 'events', body: `row ${seq}`,
    }));
    const name = 'events-00000001-00000002-12345678.chk';
    writeFileSync(join(warm, name), encodeChunk('events', rows));

    const cold = [{ file: 'seg-00000001.tar', chunks: [name], bytes: 4096 }];
    const prior = buildManifest(outDir);
    prior.version = 0; // genuinely old shape: migration is required
    prior.cold = cold;
    prior.createdAt = '2024-01-01T00:00:00.000Z';
    prior.crc32c = manifestCrc(prior);
    writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(prior, null, 1)}\n`);

    assert.equal(planMigration(outDir).needs, true, 'fixture needed migration');
    const result = migrate(outDir, { dryRun: false });
    assert.equal(result.dryRun, false);
    assert.ok(result.backup, 'migration backed up the prior manifest');

    const after = loadManifest(outDir).manifest;
    assert.equal(after.version, 1);
    assert.deepEqual(after.cold, cold, 'cold segment refs must survive migration');
    assert.equal(after.createdAt, '2024-01-01T00:00:00.000Z');
    assert.equal(
      readFileSync(join(outDir, 'manifest.pre-migrate.json'), 'utf8').includes('seg-00000001.tar'),
      true,
      'backup still carries the original cold listing',
    );
  });
});
