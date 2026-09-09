// photo gate enforcement: photo body >256KB seals as sidecar+thumb, never inline.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { encode } from 'jpeg-js';
import { join } from 'path';
import { PHOTO_INLINE_LIMIT_BYTES, readPhotoSidecar, seal } from '../src/seal.js';
import { findTrx } from '../src/find.js';
import { scratch } from './util.js';

function bigNoiseJpeg(): Buffer {
  let s = 1234;
  const rnd = (): number => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const w = 512;
  const h = 512;
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = Math.floor(rnd() * 256);
    px[i * 4 + 1] = Math.floor(rnd() * 256);
    px[i * 4 + 2] = Math.floor(rnd() * 256);
    px[i * 4 + 3] = 0xff;
  }
  return Buffer.from(encode({ data: px, width: w, height: h }, 90).data);
}

describe('photo gate', () => {
  it('photo body >256kb goes sidecar+thumb, never inline', { timeout: 120_000 }, async () => {
    const dir = scratch('photo-gate');
    const jpeg = bigNoiseJpeg();
    assert.ok(jpeg.length > PHOTO_INLINE_LIMIT_BYTES, `full ${jpeg.length}b trips the gate`);
    const blob = randomBytes(300 * 1024);
    const base = 1_700_000_000_000;
    const small = 'EVENT OK value=15000 operator=agus method=cash change=0...';
    const lines = [
      JSON.stringify({ device_id: 'dev-01', seq: 1, ts: base + 1000, id: 'trx-00000001', table: 'events', body: small }),
      JSON.stringify({ device_id: 'cam-01', seq: 2, ts: base + 2000, id: 'trx-00000002', table: 'photo', body: jpeg.toString('base64') }),
      JSON.stringify({ device_id: 'cam-01', seq: 3, ts: base + 3000, id: 'trx-00000003', table: 'photo', body: blob.toString('base64') }),
    ];
    const hotDb = join(dir, 'hot.jsonl');
    writeFileSync(hotDb, `${lines.join('\n')}\n`);
    const outDir = join(dir, 'archive');
    const r = await seal({ hotDb, outDir });
    assert.equal(r.rowsSealed, 3);

    for (const [trxId, raw] of [['trx-00000002', jpeg], ['trx-00000003', blob]] as const) {
      const found = findTrx({ outDir, trxId });
      const m = /^photo:sha256:([0-9a-f]{64}):size=(\d+)$/.exec(found.row.body);
      assert.ok(m, `${trxId} seals as a hash ref, got ${found.row.body.slice(0, 40)}`);
      assert.equal(Number(m[2]), raw.length);
      assert.ok(!found.row.body.includes(raw.toString('base64').slice(0, 64)), 'photo bytes never inline');
      assert.ok(readPhotoSidecar(outDir, found.row.body).equals(raw), 'sidecar bit-exact');
      const fullSha = createHash('sha256').update(raw).digest('hex');
      const thumbPath = join(outDir, 'photo', `thumb-${fullSha}.jpg`);
      const metaPath = join(outDir, 'photo', `thumb-${fullSha}.json`);
      assert.ok(existsSync(thumbPath), `thumb beside sidecar: ${thumbPath}`);
      assert.ok(existsSync(metaPath), 'thumb hash-link meta present');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { fullSha: string; thumbSha: string };
      assert.equal(meta.fullSha, fullSha);
      assert.equal(meta.thumbSha, createHash('sha256').update(readFileSync(thumbPath)).digest('hex'));
      assert.ok(statSync(thumbPath).size < PHOTO_INLINE_LIMIT_BYTES, 'preview stays small');
    }

    // Small text still seals inline: no sidecar, no thumb for it.
    const text = findTrx({ outDir, trxId: 'trx-00000001' });
    assert.equal(text.row.body, small);
    assert.deepEqual(readdirSync(join(outDir, 'photo')).filter((f) => f.endsWith('.bin')).length, 2);
    const warmBytes = readdirSync(join(outDir, 'warm'))
      .filter((f) => f.endsWith('.chk'))
      .reduce((n, f) => n + statSync(join(outDir, 'warm', f)).size, 0);
    assert.ok(warmBytes < 100 * 1024, `warm ${warmBytes}b carries no photo bytes`);
  });
});
