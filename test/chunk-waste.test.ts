// waste-fix codec+dict regressions: header cross-check, 16mb cap,
// dict_flag gating, inline dict_id non-authoritative, blob train skip.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeChunk, decodeChunk, decodeHeader, encodeHeader,
  decompressFrame, crc32c, HEADER_SIZE, CODEC_NONE,
  DECOMPRESS_MAX_BYTES, DICT_FLAG,
} from '../src/chunk.js';
import type { HotRow } from '../src/chunk.js';
import { trainTableDict } from '../src/dict.js';

function rows(n: number, table = 'events'): HotRow[] {
  const out: HotRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      device_id: 'dev-01', seq: i + 1, ts: 1700000000000 + i * 1000,
      id: `trx-${String(i + 1).padStart(8, '0')}`, table,
      body: `TRANSACTION OK value=15000 cashier=agus store=jakarta-selatan line=${i % 5}`,
    });
  }
  return out;
}

describe('waste-fix codec+dict', () => {
  it('rejects header seq range tamper with valid body crc', { timeout: 30_000 }, () => {
    const buf = Buffer.from(encodeChunk('events', rows(50)));
    const h = decodeHeader(buf);
    const bad = Buffer.concat([
      encodeHeader({ ...h, seqMax: h.seqMax + 100n }),
      Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + h.bodyLen)),
    ]);
    assert.throws(() => decodeChunk(bad), /seq range/);
  });

  it('rejects header row count tamper with valid body crc', { timeout: 30_000 }, () => {
    const buf = Buffer.from(encodeChunk('events', rows(50)));
    const h = decodeHeader(buf);
    const bad = Buffer.concat([
      encodeHeader({ ...h, rows: h.rows + 1 }),
      Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + h.bodyLen)),
    ]);
    assert.throws(() => decodeChunk(bad), /header rows/);
  });

  it('hard errors over 16mb decompressed output before json parse', { timeout: 30_000 }, () => {
    const big = Buffer.alloc(DECOMPRESS_MAX_BYTES + 1, 0x41);
    assert.throws(() => decompressFrame(CODEC_NONE, big), /exceeds .* cap/);
    // decodeChunk path with codec none and oversize frame body
    const frame = Buffer.alloc(DECOMPRESS_MAX_BYTES + 8, 0x20);
    const h = encodeHeader({
      ver: 1, codec: CODEC_NONE, flags: 0, tableId: 1,
      seqMin: 0n, seqMax: 0n, tsMin: 0n, tsMax: 0n,
      rows: 0, crc32c: crc32c(frame), dictId: 0, bodyLen: frame.length,
    });
    assert.throws(() => decodeChunk(Buffer.concat([h, frame])), /exceeds .* cap/);
  });

  it('ignores supplied dict when dict_flag off', { timeout: 30_000 }, () => {
    const buf = Buffer.from(encodeChunk('events', rows(20)));
    const h = decodeHeader(buf);
    assert.equal(h.flags & DICT_FLAG, 0);
    const plain = decodeChunk(buf).rows;
    const bogus = Buffer.from('bogus-dict-bytes-not-a-real-dict');
    const gated = decodeChunk(Buffer.from(buf), bogus).rows;
    assert.deepEqual(gated, plain);
  });

  it('flagless chunk with scribbled dict_id still decodes (non-authoritative)', { timeout: 30_000 }, () => {
    const buf = Buffer.from(encodeChunk('events', rows(20)));
    const h = decodeHeader(buf);
    assert.equal(h.flags & DICT_FLAG, 0);
    const scribbled = Buffer.concat([
      encodeHeader({ ...h, dictId: 0xdeadbeef }),
      Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + h.bodyLen)),
    ]);
    // crc covers body only, so recompute is unnecessary: body unchanged.
    // header dict_id scribble must not affect decode.
    const { rows: out } = decodeChunk(scribbled);
    assert.equal(out.length, 20);
  });

  it('skips trainDict for blob tables explicitly', { timeout: 30_000 }, () => {
    const bodies = rows(500).map((r) => r.body);
    const text = trainTableDict(bodies, 'events');
    assert.ok(text, 'repetitive text table trains');
    for (const t of ['photo', 'blob', 'image', 'thumb', 'PHOTO']) {
      assert.equal(trainTableDict(bodies, t), null, `blob table ${t} skips`);
    }
  });
  it('rejects unknown header ver 99', { timeout: 30_000 }, () => {
    const buf = Buffer.from(encodeChunk('events', rows(5)));
    const h = decodeHeader(buf);
    const bad = Buffer.concat([
      encodeHeader({ ...h, ver: 99 }),
      Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + h.bodyLen)),
    ]);
    assert.throws(() => decodeHeader(bad), /99/);
    assert.throws(() => decodeChunk(bad), /99/);
  });
  it('rejects header tableId scribble with valid body crc', { timeout: 30_000 }, () => {
    const buf = Buffer.from(encodeChunk('events', rows(20)));
    const h = decodeHeader(buf);
    const bad = Buffer.concat([
      encodeHeader({ ...h, tableId: (h.tableId ^ 0xffffffff) >>> 0 }),
      Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + h.bodyLen)),
    ]);
    assert.throws(() => decodeChunk(bad), /header tableId differs from frame table/);
  });
});
