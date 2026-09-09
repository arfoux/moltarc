// seal validation regression: out-of-range seq, strict numerics, sqlite schema mismatch.
// Each test FAILS pre-fix and PASSES post-fix.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { normRow, seal } from '../src/seal.js';
import { verifyAll } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

const BASE = 1_700_000_000_000;
const NAME_LINK_TAIL = /-(\d{8})-(\d{8})-([0-9a-f]{8})\.chk$/;

async function getSqlite(): Promise<typeof import('bun:sqlite') | null> {
  try {
    return await import('bun:sqlite');
  } catch {
    return null;
  }
}

describe('seal validation', () => {
  it('rejects negative and >8-digit seq at seal time; chunks keep NAME_LINK', { timeout: 60_000 }, async () => {
    const dir = scratch('sealvalid-seq');
    const { hotDb } = writeHotLog(dir, { rows: 300 });
    // 2 malformed / 302 total = 0.66%: under the 1% abort, so seal must succeed.
    appendFileSync(hotDb, `${JSON.stringify({ device_id: 'dev-01', seq: -5, ts: BASE, id: 'trx-neg', table: 'events', body: 'bad negative' })}\n`);
    appendFileSync(hotDb, `${JSON.stringify({ device_id: 'dev-01', seq: 100_000_000, ts: BASE, id: 'trx-big', table: 'events', body: 'bad oversize' })}\n`);
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 300);
    assert.equal(r.rowsMalformed, 2);
    assert.equal(r.rowsSkipped, 0);
    // Pre-fix the 9-digit seq seals as a non-8-digit filename and verify goes CORRUPT.
    for (const f of readdirSync(join(outDir, 'warm')).filter((f) => f.endsWith('.chk'))) {
      assert.match(f, NAME_LINK_TAIL, `chunk filename lost NAME_LINK: ${f}`);
    }
    assert.equal(verifyAll(outDir).ok, true);
  });

  it('normRow rejects empty-string, float, negative numerics (no silent 0)', { timeout: 60_000 }, async () => {
    const base = { device_id: 'd', ts: BASE, id: 'x', table: 't', body: 'b' };
    // Pre-fix Number('') is 0 (silent), floats/negatives pass as finite.
    assert.equal(normRow({ ...base, seq: '' }, 'log'), null);
    assert.equal(normRow({ ...base, seq: 1.5 }, 'log'), null);
    assert.equal(normRow({ ...base, seq: -3 }, 'log'), null);
    assert.equal(normRow({ ...base, seq: 0 }, 'log'), null);
    assert.equal(normRow({ ...base, seq: 5, ts: '' }, 'log'), null);
    assert.equal(normRow({ ...base, seq: 5, ts: -1 }, 'log'), null);
    assert.equal(normRow({ ...base, seq: 5, ts: 1.5 }, 'log'), null);
    assert.equal(normRow({ ...base }, 'log'), null);
    // Numeric strings still coerce; integer ts strings stay valid.
    assert.equal(normRow({ ...base, seq: '5' }, 'log')?.seq, 5);
    assert.equal(normRow({ ...base, seq: 5, ts: String(BASE) }, 'log')?.ts, BASE);

    // Same inputs through a full seal count as malformed, never skipped/sealed.
    const dir = scratch('sealvalid-num');
    const { hotDb } = writeHotLog(dir, { rows: 400 });
    // 3 malformed / 403 total = 0.74%: under the 1% abort.
    for (const bad of ['', 1.5, -2]) {
      appendFileSync(hotDb, `${JSON.stringify({ device_id: 'dev-01', seq: bad, ts: BASE, id: `bad-${String(bad)}`, table: 'events', body: 'bad' })}\n`);
    }
    const r = await seal({ hotDb, outDir: join(dir, 'arch') });
    assert.equal(r.rowsMalformed, 3);
    assert.equal(r.rowsSealed, 400);
  });

  it('sqlite alt-column table seals via fallback instead of missing-column throw', { timeout: 30_000 }, async (t) => {
    const sqlite = await getSqlite();
    if (!sqlite) {
      t.skip('bun:sqlite unavailable on this runtime');
      return;
    }
    const dir = scratch('sealvalid-sqlite-alt');
    const dbPath = join(dir, 'hot.db');
    const db = new sqlite.Database(dbPath, { create: true });
    // No seq/ts/id/"table"/body columns: strict SELECT throws pre-fix.
    // normRow aliases (no/waktu/trx/kind/payload) recover every row post-fix.
    db.run('CREATE TABLE tx (device_id TEXT, no INTEGER, waktu INTEGER, trx TEXT, kind TEXT, payload TEXT)');
    db.run('BEGIN');
    const ins = db.query('INSERT INTO tx (device_id, no, waktu, trx, kind, payload) VALUES (?,?,?,?,?,?)');
    for (let i = 0; i < 50; i++) {
      ins.run('dev-01', i + 1, BASE + i * 1000, `trx-${String(i + 1).padStart(8, '0')}`, 'events', `cash sale ${i}`);
    }
    db.run('COMMIT');
    db.close();
    const r = await seal({ hotDb: dbPath, outDir: join(dir, 'arch'), table: 'tx' });
    assert.equal(r.rowsSealed, 50);
    assert.equal(r.rowsMalformed, 0);
  });

  it('sqlite junk-column table takes the malformed path, not a sqlite throw', { timeout: 30_000 }, async (t) => {
    const sqlite = await getSqlite();
    if (!sqlite) {
      t.skip('bun:sqlite unavailable on this runtime');
      return;
    }
    const dir = scratch('sealvalid-sqlite-junk');
    const dbPath = join(dir, 'hot.db');
    const db = new sqlite.Database(dbPath, { create: true });
    db.run('CREATE TABLE log (foo TEXT)');
    db.run('BEGIN');
    const ins = db.query('INSERT INTO log (foo) VALUES (?)');
    for (let i = 0; i < 10; i++) ins.run(`row-${i}`);
    db.run('COMMIT');
    db.close();
    // All 10 rows unusable: 100% malformed aborts via the malformed path.
    // Pre-fix this rejects with a sqlite "no such column" error instead.
    await assert.rejects(
      seal({ hotDb: dbPath, outDir: join(dir, 'arch') }),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /malformed/);
        assert.doesNotMatch(msg, /no such column/i);
        return true;
      },
    );
  });
});
