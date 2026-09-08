// migbloom regressions: legacy bloom fail-open, torn-copy crc guard, readonly refusals.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { bloomCheck, buildBloom, manifestCrc } from '../src/manifest.js';
import type { ChunkEntry, Manifest } from '../src/manifest.js';
import { planMigration } from '../src/migrate.js';
import { openArchiveReadOnly } from '../src/readonly.js';
import { scratch } from './util.js';

function v1Entry(): ChunkEntry {
  const ids = ['trx-00000001', 'trx-00000002'];
  return {
    file: 'sales-00000001-00000002-abcdef12.chk',
    table: 'sales', seqMin: 1, seqMax: 2,
    tsMin: 1_700_000_000_000, tsMax: 1_700_000_001_000,
    rows: 2, bytes: 100, sha256: '0'.repeat(64), crc32c: 0,
    dictId: 0, codec: 0,
    minKey: ids[0], maxKey: ids[1], bloom: buildBloom(ids),
  };
}

function stampedV1(): { text: string } {
  const m: Manifest = {
    version: 1, createdAt: '2024-05-01T00:00:00.000Z',
    chunks: [v1Entry()], cold: [], seq: 7,
  };
  m.crc32c = manifestCrc(m);
  return { text: JSON.stringify(m) };
}

describe('migbloom regressions', () => {
  it('legacy bloomCheck short buffer fails OPEN (never prunes a possibly-live chunk)', { timeout: 30_000 }, () => {
    const ids = ['trx-00000001', 'trx-00000002', 'trx-00000003'];
    const full = buildBloom(ids);
    for (const id of ids) assert.equal(bloomCheck(full, id), true, 'member must hit');
    assert.equal(bloomCheck('', ids[0]), true, 'empty bloom must fail open');
    const short = Buffer.from(full, 'base64').subarray(0, 37).toString('base64');
    for (const id of ids) assert.equal(bloomCheck(short, id), true, 'truncated bloom must fail open');
    assert.equal(bloomCheck('!!!not-base64!!!', ids[0]), true, 'corrupt bloom must fail open');
  });

  it('planMigration skips a torn (crc-broken) primary and reads the next copy', { timeout: 30_000 }, () => {
    const outDir = scratch('migbloom');
    const primary = join(outDir, 'manifest.json');
    const backup = join(outDir, 'manifest.bak.json');
    const { text } = stampedV1();
    // Torn primary: one flipped char inside a string value keeps JSON
    // parseable but breaks the envelope crc.
    const torn = text.replace('2024-05-01', '2024-05-02');
    assert.notEqual(torn, text, 'setup must actually tear the copy');
    assert.doesNotThrow(() => JSON.parse(torn), 'torn copy must stay JSON-parseable');
    writeFileSync(primary, torn);
    // Old-shape backup with no envelope: accepted as-is, needs migration.
    writeFileSync(backup, JSON.stringify({ version: 0, createdAt: '2024-05-01T00:00:00.000Z', chunks: [] }));
    const plan = planMigration(outDir);
    assert.equal(plan.needs, true, 'torn primary must not mask the old backup');
    assert.equal(plan.version, 0, 'plan must come from the backup copy');

    // Torn primary with no backup at all: nothing crc-valid to accept.
    rmSync(backup);
    const plan2 = planMigration(outDir);
    assert.equal(plan2.needs, true, 'torn-only primary must not plan clean');
    assert.equal(plan2.version, -1, 'no crc-valid copy remains');

    // Torn primary with a valid v1 backup: falls through, already v1.
    writeFileSync(backup, text);
    const plan3 = planMigration(outDir);
    assert.equal(plan3.needs, false, 'valid backup rescues a torn primary');
    assert.equal(readFileSync(primary, 'utf8'), torn, 'dry-run planning writes nothing');
  });

  it('readonly handle refuses migrate, p2p sync apply, casGc, packBundle', { timeout: 30_000 }, () => {
    const outDir = scratch('migbloom-ro');
    const ro = openArchiveReadOnly(outDir);
    assert.equal(Object.isFrozen(ro), true, 'handle stays frozen');
    for (const op of ['migrate', 'syncFromPeer', 'casGc', 'packBundle'] as const) {
      assert.throws(
        () => (ro[op] as (...a: unknown[]) => never)({ outDir }),
        /read-only/,
        `${op} must refuse`,
      );
      assert.throws(
        () => (ro[op] as (...a: unknown[]) => never)(),
        new RegExp(op),
        `${op} error must name the op`,
      );
    }
  });
});
