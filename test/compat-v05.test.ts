// v0.5-era cold archive fixture: hand-rolled builder using only the old
// shape (header ver 0, deflate body, frame v 0, manifest version 0 with a
// minimal entry shape). Proves the current reader still opens old archives.
// NOTE: deliberately avoids encodeChunk/encodeHeader/encodeRows and
// buildManifest/saveManifestAtomic — those are the current writers, and a
// compat fixture must not depend on them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { crc32c, decodeHeader, fnv1a32, sha256hex } from '../src/chunk.js';
import { findTrx } from '../src/find.js';
import { loadManifest } from '../src/manifest.js';
import { verifyFull } from '../src/verify.js';
import { scratch } from './util.js';

// Old constants: header ver predates VERSION=1, frame v predates v:1,
// codec is deflate (larger, but every reader must still decode it).
const V05_HEADER_VER = 0;
const V05_FRAME_V = 0;
const CODEC_DEFLATE = 2;

interface V05Row {
  device_id: string;
  seq: number;
  ts: number;
  id: string;
  table: string;
  body: string;
}

function v05Rows(seqBase: number, count: number): V05Row[] {
  const base = 1_700_000_000_000;
  const rows: V05Row[] = [];
  for (let i = 0; i < count; i++) {
    const seq = seqBase + i;
    rows.push({
      device_id: 'pos-01',
      seq,
      ts: base + seq * 1000,
      id: `trx-${String(seq).padStart(8, '0')}`,
      table: 'sales',
      body: `TRANSACTION OK amount=${15000 + seq} cashier=agus store=jakarta-selatan`,
    });
  }
  return rows;
}

// Hand-written v0.5 chunk: JSON columnar frame (v:0) + deflate + 64B header (ver 0).
function buildV05Chunk(table: string, rows: V05Row[]): Buffer {
  const pool: string[] = [];
  const poolIdx = new Map<string, number>();
  const runs: Array<[number, number]> = [];
  for (const r of rows) {
    let p = poolIdx.get(r.body);
    if (p === undefined) { p = pool.length; poolIdx.set(r.body, p); pool.push(r.body); }
    const last = runs[runs.length - 1];
    if (last && last[0] === p) last[1]++;
    else runs.push([p, 1]);
  }
  const frame = {
    v: V05_FRAME_V,
    table,
    dev: ['pos-01'],
    seqB: rows[0].seq,
    seqD: rows.map((r, i) => (i === 0 ? 0 : r.seq - rows[i - 1].seq)),
    tsB: rows[0].ts,
    tsD: rows.map((r, i) => (i === 0 ? 0 : r.ts - rows[i - 1].ts)),
    ids: rows.map((r) => r.id),
    devI: rows.map(() => 0),
    pool,
    runs,
  };
  const body = deflateSync(Buffer.from(JSON.stringify(frame), 'utf8'));
  const h = Buffer.alloc(64);
  h.write('UMK1', 0, 'ascii');
  h.writeUInt16LE(V05_HEADER_VER, 4);
  h.writeUInt8(CODEC_DEFLATE, 6);
  h.writeUInt8(0, 7); // flags: pre-dict era, no DICT_FLAG
  h.writeUInt32LE(fnv1a32(table) >>> 0, 8);
  h.writeBigUInt64LE(BigInt(rows[0].seq), 12);
  h.writeBigUInt64LE(BigInt(rows[rows.length - 1].seq), 20);
  h.writeBigInt64LE(BigInt(rows[0].ts), 28);
  h.writeBigInt64LE(BigInt(rows[rows.length - 1].ts), 36);
  h.writeUInt32LE(rows.length, 44);
  h.writeUInt32LE(crc32c(body) >>> 0, 48);
  h.writeUInt32LE(0, 52); // dictId: none in v0.5
  h.writeUInt32LE(body.length, 56);
  h.writeUInt32LE(0, 60); // reserved
  return Buffer.concat([h, body]);
}

// Hand-written v0.5 archive: warm/*.chk + dual manifest copies in the old
// minimal shape (no dictId/codec/minKey/maxKey/bloom, no cold[]) plus one
// unknown field per entry that the current reader must ignore.
function buildV05Archive(outDir: string): { files: string[]; ids: string[] } {
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const files: string[] = [];
  const ids: string[] = [];
  const entries: Array<Record<string, unknown>> = [];
  const groups = [v05Rows(1, 3), v05Rows(4, 3)];
  for (const rows of groups) {
    const bytes = buildV05Chunk('sales', rows);
    const sha = sha256hex(bytes);
    const pad = (n: number) => String(n).padStart(8, '0');
    const name = `sales-${pad(rows[0].seq)}-${pad(rows[rows.length - 1].seq)}-${sha.slice(0, 8)}.chk`;
    writeFileSync(join(warm, name), bytes);
    files.push(name);
    for (const r of rows) ids.push(r.id);
    entries.push({
      file: name,
      table: 'sales',
      seqMin: rows[0].seq,
      seqMax: rows[rows.length - 1].seq,
      tsMin: rows[0].ts,
      tsMax: rows[rows.length - 1].ts,
      rows: rows.length,
      bytes: bytes.length,
      sha256: sha,
      crc32c: crc32c(bytes.subarray(64)) >>> 0,
      sealedBy: 'molt-0.5', // unknown field: reader must tolerate
    });
  }
  const manifest = { version: 0, createdAt: '2024-01-01T00:00:00.000Z', chunks: entries };
  const payload = `${JSON.stringify(manifest, null, 1)}\n`;
  writeFileSync(join(outDir, 'manifest.json'), payload);
  writeFileSync(join(outDir, 'manifest.bak.json'), payload);
  return { files, ids };
}

describe('v0.5 cold archive compat', () => {
  it('old header ver + deflate body decodes under the current reader', () => {
    const dir = scratch('compat-v05');
    const outDir = join(dir, 'archive');
    const { files } = buildV05Archive(outDir);
    assert.equal(files.length, 2);
    const { manifest } = loadManifest(outDir);
    assert.equal(manifest.version, 0);
    assert.deepEqual(manifest.cold ?? [], []);
  });

  it('find reads every v0.5 row with no bloom/minmax index', () => {
    const dir = scratch('compat-v05-find');
    const outDir = join(dir, 'archive');
    const { ids } = buildV05Archive(outDir);
    for (const id of ids) {
      const found = findTrx({ outDir, trxId: id });
      assert.equal(found.row.id, id);
      assert.equal(found.row.table, 'sales');
      assert.ok(found.row.body.includes('TRANSACTION OK'));
    }
    const mid = findTrx({ outDir, trxId: ids[4] });
    assert.equal(mid.row.seq, 5);
    // No min/max + no bloom in the old manifest: nothing pruned, chunks fetched in order.
    assert.equal(mid.chunksPruned, 0);
    assert.equal(mid.chunksFetched, 2);
  });

  it('verify walks a v0.5 archive clean', () => {
    const dir = scratch('compat-v05-verify');
    const outDir = join(dir, 'archive');
    buildV05Archive(outDir);
    const full = verifyFull(outDir);
    assert.equal(full.ok, true);
    assert.equal(full.manifest.source, 'primary');
    assert.ok(full.items.every((i) => i.status === 'OK'));
    assert.deepEqual(full.bad, []);
    assert.deepEqual(full.chain, []);
  });
});

// Reader-side assertion, kept next to the fixture: the header ver gate (if
// any is ever added) must keep accepting ver 0 — this is the N-2 floor.
describe('v0.5 header floor', () => {
  it('decodeHeader accepts ver 0 without a version error', () => {
    const buf = buildV05Chunk('sales', v05Rows(1, 1));
    const header = decodeHeader(buf);
    assert.equal(header.ver, 0);
    assert.equal(header.codec, CODEC_DEFLATE);
    assert.equal(header.rows, 1);
  });
});
