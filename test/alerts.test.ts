// unacked-escalation alerts: clean, growing unacked, full disk simulated, quarantined.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { seal } from '../src/seal.js';
import { ship } from '../src/ship.js';
import { loadManifest } from '../src/manifest.js';
import { quarantine } from '../src/verify.js';
import { checkUnacked } from '../src/alerts.js';
import { RESERVE_BYTES } from '../src/gc.js';
import { scratch, writeHotLog } from './util.js';

const BIG_FREE = RESERVE_BYTES * 10;

async function sealedDirs(name: string, rows: number): Promise<{ outDir: string; relayDir: string }> {
  const dir = scratch(name);
  const { hotDb } = writeHotLog(dir, { rows, uniqueBodies: true });
  const outDir = join(dir, 'archive');
  const relayDir = join(dir, 'relay');
  await seal({ hotDb, outDir, targetBytes: 16 * 1024 });
  return { outDir, relayDir };
}

describe('unacked alerts', () => {
  it('clean shipped archive is ok', { timeout: 30_000 }, async () => {
    const { outDir, relayDir } = await sealedDirs('alert-clean', 1500);
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const a = checkUnacked(outDir, relayDir, { freeBytes: BIG_FREE });
    assert.equal(a.unacked, 0);
    assert.equal(a.quarantined, 0);
    assert.equal(a.level, 'ok');
    assert.deepEqual(a.reasons, []);
  });

  it('growing unacked escalates warn then critical', { timeout: 30_000 }, async () => {
    const { outDir, relayDir } = await sealedDirs('alert-grow', 4000);
    const warn = checkUnacked(outDir, relayDir, { warnUnacked: 1, critUnacked: 100, freeBytes: BIG_FREE });
    assert.ok(warn.unacked >= 1, `expected unacked growth, got ${warn.unacked}`);
    assert.equal(warn.level, 'warn');
    const crit = checkUnacked(outDir, relayDir, { warnUnacked: 1, critUnacked: 2, freeBytes: BIG_FREE });
    assert.ok(crit.unacked >= 2, `expected >=2 unacked, got ${crit.unacked}`);
    assert.equal(crit.level, 'critical');
  });

  it('full disk simulated is critical', { timeout: 30_000 }, async () => {
    const { outDir, relayDir } = await sealedDirs('alert-disk', 500);
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const a = checkUnacked(outDir, relayDir, { freeBytes: 1024 });
    assert.equal(a.level, 'critical');
    assert.ok(a.reasons.some((r) => r.startsWith('free ')));
  });

  it('quarantined chunk escalates', { timeout: 30_000 }, async () => {
    const { outDir, relayDir } = await sealedDirs('alert-quar', 4000);
    await ship({ outDir, relayDir, baseDelayMs: 1 });
    const victim = loadManifest(outDir).manifest.chunks[0].file;
    quarantine(outDir, victim);
    const warn = checkUnacked(outDir, relayDir, { freeBytes: BIG_FREE });
    assert.equal(warn.quarantined, 1);
    assert.equal(warn.level, 'warn');
    const crit = checkUnacked(outDir, relayDir, { warnQuarantined: 1, critQuarantined: 1, freeBytes: BIG_FREE });
    assert.equal(crit.level, 'critical');
  });
});
