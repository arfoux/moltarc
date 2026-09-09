// seal waste-fix regression: bounded seal, malformed abort, photo gate, probe estimator.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { seal, readPhotoSidecar } from '../src/seal.js';
import { findTrx } from '../src/find.js';
import { verifyAll } from '../src/verify.js';
import { scratch, writeHotLog } from './util.js';

describe('seal waste-fix', () => {
  it('bounded seal advances watermark per flush; resume loses nothing', { timeout: 60_000 }, async () => {
    const dir = scratch('seal-maxrows');
    const { hotDb } = writeHotLog(dir, { rows: 1000 });
    const outDir = join(dir, 'arch');
    const first = await seal({ hotDb, outDir, maxRows: 200, targetBytes: 16 * 1024 });
    assert.equal(first.rowsSealed, 200);
    assert.ok(first.chunks.length >= 1);
    const wm = JSON.parse(readFileSync(join(outDir, 'sealed_upto_seq'), 'utf8')) as Record<string, number>;
    assert.equal(wm['dev-01'], 200);
    const second = await seal({ hotDb, outDir });
    assert.equal(second.rowsSealed, 800);
    assert.equal(second.rowsSkipped, 200);
    const wm2 = JSON.parse(readFileSync(join(outDir, 'sealed_upto_seq'), 'utf8')) as Record<string, number>;
    assert.equal(wm2['dev-01'], 1000);
    assert.ok(verifyAll(outDir).ok);
  });

  it('counts malformed rows and aborts past 1 percent', { timeout: 60_000 }, async () => {
    const dir = scratch('seal-malformed-ok');
    const { hotDb } = writeHotLog(dir, { rows: 200 });
    appendFileSync(hotDb, 'not json\n{broken\n');
    const r = await seal({ hotDb, outDir: join(dir, 'arch') });
    assert.equal(r.rowsMalformed, 2);
    assert.equal(r.rowsSealed, 200);

    const dir2 = scratch('seal-malformed-abort');
    const g2 = writeHotLog(dir2, { rows: 100 });
    for (let i = 0; i < 5; i++) appendFileSync(g2.hotDb, `bad line ${i}\n`);
    await assert.rejects(seal({ hotDb: g2.hotDb, outDir: join(dir2, 'arch') }), /malformed/);
  });

  it('photo gate quarantines >256kb base64 to sidecar hash-ref', { timeout: 60_000 }, async () => {
    const dir = scratch('seal-photo');
    const big = randomBytes(300 * 1024).toString('base64');
    const base = 1_700_000_000_000;
    const lines = [1, 2, 3].map((s) => JSON.stringify({
      device_id: 'dev-01', seq: s, ts: base + s * 1000,
      id: `trx-${String(s).padStart(8, '0')}`, table: 'events', body: `cash sale ${s}`,
    }));
    const photoId = 'trx-00000004';
    lines.push(JSON.stringify({
      device_id: 'cam-01', seq: 4, ts: base + 4000,
      id: photoId, table: 'photo', body: big,
    }));
    const hotDb = join(dir, 'hot.jsonl');
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 4);
    const found = findTrx({ outDir, trxId: photoId });
    assert.match(found.row.body, /^photo:sha256:[0-9a-f]{64}:size=\d+$/);
    assert.ok(!found.row.body.includes(big.slice(0, 64)), 'photo bytes sealed inline');
    assert.equal(readPhotoSidecar(outDir, found.row.body).toString('base64'), big);
    const warmBytes = readdirSync(join(outDir, 'warm'))
      .filter((f) => f.endsWith('.chk'))
      .reduce((n, f) => n + statSync(join(outDir, 'warm', f)).size, 0);
    assert.ok(warmBytes < 100 * 1024, `warm ${warmBytes}b carries photo bytes inline`);
  });

  it('probe estimator seals exact rows with few full encodes', { timeout: 120_000 }, async () => {
    const dir = scratch('seal-probe');
    const { hotDb, ids } = writeHotLog(dir, { rows: 8000, uniqueBodies: true });
    const outDir = join(dir, 'arch');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 8000);
    assert.ok(r.probeEncodes < 8000 / 400, `probes ${String(r.probeEncodes)} should beat recompress-every-400`);
    assert.ok(verifyAll(outDir).ok);
    assert.equal(findTrx({ outDir, trxId: ids[0] }).row.id, ids[0]);
    assert.equal(findTrx({ outDir, trxId: ids[ids.length - 1] }).row.id, ids[ids.length - 1]);
  });
});
