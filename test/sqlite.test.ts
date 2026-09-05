// Seal reads hot.db directly: magic autodetect + bun:sqlite tx/log tables.
// Skips on runtimes without bun:sqlite (plain node); runs fully under bun.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { seal, isSqliteFile } from '../src/seal.js';
import { findTrx } from '../src/find.js';
import { scratch } from './util.js';

async function getSqlite(): Promise<typeof import('bun:sqlite') | null> {
  try {
    return await import('bun:sqlite');
  } catch {
    return null;
  }
}

describe('seal from sqlite', () => {
  it('reads hot.db tx table with magic autodetect', async (t) => {
    const sqlite = await getSqlite();
    if (!sqlite) {
      t.skip('bun:sqlite unavailable on this runtime');
      return;
    }
    const dir = scratch('sqlite');
    const dbPath = join(dir, 'hot.db');
    const db = new sqlite.Database(dbPath, { create: true });
    db.run('CREATE TABLE tx (device_id TEXT, seq INTEGER, ts INTEGER, id TEXT, "table" TEXT, body TEXT)');
    db.run('BEGIN');
    const ins = db.query('INSERT INTO tx (device_id, seq, ts, id, "table", body) VALUES (?,?,?,?,?,?)');
    const base = 1_700_000_000_000;
    for (let i = 0; i < 800; i++) {
      const seq = i + 1;
      ins.run('pos-01', seq, base + i * 1000, `trx-${String(seq).padStart(8, '0')}`, 'sales',
        `TRANSACTION OK amount=${5000 + (i % 20) * 10000} cashier=agus tend=qris store=bogor-kota`);
    }
    db.run('COMMIT');
    db.close();

    assert.equal(isSqliteFile(dbPath), true);
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb: dbPath, outDir });
    assert.equal(r.rowsSealed, 800);
    assert.ok(r.chunks.length >= 1);
    const found = findTrx({ outDir, trxId: 'trx-00000400' });
    assert.equal(found.row.id, 'trx-00000400');
    assert.match(found.row.body, /TRANSACTION OK/);

    // JSONL next to it still detects as non-sqlite.
    const jsonl = join(dir, 'hot.jsonl');
    writeFileSync(jsonl, '{"device_id":"d","seq":1,"ts":1,"id":"a","table":"t","body":"b"}\n');
    assert.equal(isSqliteFile(jsonl), false);
  });
});
