// clifix regressions: seal --table, ship strict flags, fail stack,
// sensor clean baseline, orphan-sweep name class.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, utimesSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { flagAnomalies } from '../src/sensor.js';
import type { SensorPoint } from '../src/sensor.js';
import { findTrx } from '../src/find.js';
import { scratch, writeHotLog } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'moltarc.ts');

function run(...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function runFail(...args: string[]): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: unknown) {
    if (e !== null && typeof e === 'object' && 'status' in e) {
      const err = e as { status: unknown; stderr: unknown };
      return { status: Number(err.status), stderr: String(err.stderr ?? '') };
    }
    throw e;
  }
  assert.fail(`expected CLI to fail: moltarc ${args.join(' ')}`);
}

// bun:sqlite exists only under bun; dynamic import keeps this file loadable
// on plain node (matching test/sqlite.test.ts), skipping the sqlite case there.
async function getSqlite(): Promise<typeof import('bun:sqlite') | null> {
  try {
    return await import('bun:sqlite');
  } catch {
    return null;
  }
}

describe('clifix', () => {
  it('seal --table selects the sqlite table from the CLI', { timeout: 60_000 }, async (t) => {
    const sqlite = await getSqlite();
    if (!sqlite) {
      t.skip('bun:sqlite unavailable on this runtime');
      return;
    }
    const dir = scratch('clifix-seal');
    const dbPath = join(dir, 'hot.db');
    const db = new sqlite.Database(dbPath, { create: true });
    db.run('CREATE TABLE tx (device_id TEXT, seq INTEGER, ts INTEGER, id TEXT, "table" TEXT, body TEXT)');
    db.run('CREATE TABLE audit (device_id TEXT, seq INTEGER, ts INTEGER, id TEXT, "table" TEXT, body TEXT)');
    const base = 1_700_000_000_000;
    db.run('BEGIN');
    const txIns = db.query('INSERT INTO tx (device_id, seq, ts, id, "table", body) VALUES (?,?,?,?,?,?)');
    for (let i = 0; i < 10; i++) {
      txIns.run('dev-01', i + 1, base + i * 1000, `trx-${String(i + 1).padStart(8, '0')}`, 'events',
        `EVENT OK value=${15000 + i} operator=agus site=north-1..............`);
    }
    const auIns = db.query('INSERT INTO audit (device_id, seq, ts, id, "table", body) VALUES (?,?,?,?,?,?)');
    for (let i = 0; i < 5; i++) {
      auIns.run('dev-01', i + 1, base + i * 1000, `audit-${String(i + 1).padStart(8, '0')}`, 'audit',
        `AUDIT CHECK seq=${i + 1} site=north-1.........`);
    }
    db.run('COMMIT');
    db.close();

    const auditOut = run('seal', dbPath, join(dir, 'audit-archive'), '--table', 'audit');
    assert.match(auditOut, /sealed 5 rows/);
    const found = findTrx({ outDir: join(dir, 'audit-archive'), trxId: 'audit-00000003' });
    assert.equal(found.row.id, 'audit-00000003');

    const defaultOut = run('seal', dbPath, join(dir, 'default-archive'));
    assert.match(defaultOut, /sealed 10 rows/);
  });

  it('ship rejects unknown flags instead of silently ignoring them', { timeout: 60_000 }, () => {
    const dir = scratch('clifix-ship');
    const { hotDb } = writeHotLog(dir, { rows: 50 });
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    run('seal', hotDb, outDir);
    const bad = runFail('ship', outDir, relayDir, '--bogus');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /usage: moltarc ship/);
    const ok = run('ship', outDir, relayDir, '--blobs');
    assert.match(ok, /shipped \d+ chunk\(s\)/);
  });

  it('fail prints the error stack when present', { timeout: 60_000 }, () => {
    const dir = scratch('clifix-fail');
    const r = runFail('seal', join(dir, 'missing.jsonl'), join(dir, 'archive'));
    assert.match(r.stderr, /^\s*at /m);
  });

  it('second spike stays flagged once the first is excluded from the baseline', { timeout: 30_000 }, () => {
    const base = 1_700_000_000_000;
    const calm: SensorPoint[] = Array.from({ length: 12 }, (_, i) => ({ ts: base + i * 1000, value: 15, id: `c-${i}` }));
    const huge: SensorPoint = { ts: base + 12_000, value: 8000, id: 'c-huge' };
    const next: SensorPoint = { ts: base + 13_000, value: 120, id: 'c-next' };
    const flags = flagAnomalies([...calm, huge, next], { window: 8, z: 3 });
    assert.equal(flags.slice(0, 12).every((f) => !f), true);
    assert.equal(flags[12], true);
    assert.equal(flags[13], true, 'second spike stays flagged once the first is excluded from the baseline');
  });

  it('orphan sweep reaps stale dead-pid dirs with digit/uppercase names', { timeout: 60_000 }, (t) => {
    let dead: number | null = null;
    for (let pid = 200000; pid < 201000; pid++) {
      try {
        process.kill(pid, 0);
      } catch {
        dead = pid;
        break;
      }
    }
    if (dead === null) {
      t.skip('no dead pid found for orphan probe');
      return;
    }
    const full = join(tmpdir(), `moltarc-Clifix9-${dead}-${Date.now().toString(36)}-zz99`);
    mkdirSync(full, { recursive: true });
    const old = new Date(Date.now() - 3600_000);
    utimesSync(full, old, old);
    for (let i = 0; i < 100 && existsSync(full); i++) scratch('clifix-sweep');
    assert.equal(!existsSync(full), true, 'stale digit/uppercase orphan was not reaped');
  });
});
