// seal lockfile regression: a second seal while locked must error clearly,
// never watermark-race. Each test FAILS pre-fix (no lockfile) and PASSES post-fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { scratch, writeHotLog } from './util.js';

function lockErrorCode(e: unknown): string | undefined {
  if (e !== null && typeof e === 'object' && 'code' in e) {
    const code = e.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

describe('seal lockfile', () => {
  it('second seal while locked errors clearly and writes nothing', { timeout: 60_000 }, async () => {
    const dir = scratch('seallock-held');
    const { hotDb } = writeHotLog(dir, { rows: 10 });
    const outDir = join(dir, 'arch');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'seal.lock'), `${process.pid}\n`);
    // Pre-fix there is no lock: this seal succeeds instead of rejecting.
    await assert.rejects(seal({ hotDb, outDir }), /seal locked.*held by pid/);
    // The loser never reached the write path: no watermark, no chunks.
    assert.equal(existsSync(join(outDir, 'sealed_upto_seq')), false, 'locked seal must not advance the watermark');
    assert.equal(existsSync(join(outDir, 'warm')), false, 'locked seal must not create chunks');
    assert.equal(existsSync(join(outDir, 'manifest.json')), false, 'locked seal must not write a manifest');
  });

  it('stale lock from a dead pid is removed and the seal proceeds', { timeout: 60_000 }, async () => {
    const dir = scratch('seallock-stale');
    const { hotDb } = writeHotLog(dir, { rows: 10 });
    const outDir = join(dir, 'arch');
    mkdirSync(outDir, { recursive: true });
    const deadPid = 2147483647;
    try {
      process.kill(deadPid, 0);
      assert.fail('test setup: probe pid is alive, pick another dead pid');
    } catch (e) {
      assert.equal(lockErrorCode(e), 'ESRCH', 'probe pid must be dead for a stale-lock test');
    }
    const lockPath = join(outDir, 'seal.lock');
    writeFileSync(lockPath, `${deadPid}\n`);
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 10);
    // Pre-fix the stale file is ignored and left behind; post-fix it is gone.
    assert.equal(existsSync(lockPath), false, 'stale lock must be removed, never left behind');
  });

  it('unparsable lock content stays locked and loud', { timeout: 60_000 }, async () => {
    const dir = scratch('seallock-garbage');
    const { hotDb } = writeHotLog(dir, { rows: 10 });
    const outDir = join(dir, 'arch');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'seal.lock'), 'not-a-pid\n');
    // Pre-fix there is no lock: this seal succeeds instead of rejecting.
    await assert.rejects(seal({ hotDb, outDir }), /seal locked/);
    assert.equal(existsSync(join(outDir, 'sealed_upto_seq')), false, 'locked seal must not advance the watermark');
  });

  it('a normal seal leaves no lock behind', { timeout: 60_000 }, async () => {
    const dir = scratch('seallock-clean');
    const { hotDb } = writeHotLog(dir, { rows: 10 });
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 10);
    assert.equal(existsSync(join(outDir, 'seal.lock')), false, 'released lock must not litter the archive');
  });
});
