// failfix.test.ts — fail-closed regression pins for round-7 deep review:
// (1) freeSpaceBytes fails closed (0) when statfs is unmeasurable, so the
// 50MB reserve refuses instead of letting seal/merge half-write on a full
// disk; (2) mergeCold refuses when a manifest-named warm file is missing
// instead of writing a partial segment as success.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { checkReserve, freeSpaceBytes } from '../src/gc.js';
import { mergeCold } from '../src/cold.js';
import { seal } from '../src/seal.js';
import { scratch, writeHotLog } from './util.js';

describe('failfix fail-closed guards', () => {
  it('freeSpaceBytes returns 0 when the disk cannot be measured', { timeout: 30_000 }, () => {
    const dir = scratch('failfix-space');
    const missing = join(dir, 'no-such-dir');
    assert.equal(freeSpaceBytes(missing), 0, 'unmeasurable disk must read as no space, never infinite space');
    assert.ok(freeSpaceBytes(dir) > 0, 'a readable dir still reports real space');
    assert.throws(() => checkReserve(dir, 0, 'seal'), /refused/, 'zero measured space refuses the write path');
  });

  it('mergeCold refuses a missing warm file instead of packing a partial segment', { timeout: 60_000 }, async () => {
    const dir = scratch('failfix-mergemissing');
    const { hotDb } = writeHotLog(dir, { rows: 1500, table: 'events' });
    const outDir = join(dir, 'archive');
    await seal({ hotDb, outDir });
    const warm = readdirSync(join(outDir, 'warm')).filter((f) => f.endsWith('.chk'));
    assert.ok(warm.length >= 1, 'fixture seals at least one chunk');
    unlinkSync(join(outDir, 'warm', warm[0]));
    assert.throws(() => mergeCold(outDir), /warm file missing/, 'merge names the missing source and refuses');
  });
});
