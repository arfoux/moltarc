// molt migrate test: old v0 archive forward-migrates to v1 without
// rewriting chunk history. Uses a hand-rolled v0.5 builder (never the
// current writers) so the fixture is genuinely old.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'fs';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { crc32c, fnv1a32, sha256hex } from '../src/chunk.js';
import { findTrx } from '../src/find.js';
import { loadManifest, manifestCrc } from '../src/manifest.js';
import { assertMigrated, migrate, needsMigration, planMigration } from '../src/migrate.js';
import { verifyFull } from '../src/verify.js';
import { ship } from '../src/ship.js';
import { scratch } from './util.js';

const V05_HEADER_VER = 0;
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
  const rows: V05Row[] = [];
  for (let i = 0; i < count; i++) {
    const seq = seqBase + i;
    rows.push({
      device_id: 'pos-01', seq, ts: 1_700_000_000_000 + seq * 1000,
      id: `trx-${String(seq).padStart(8, '0')}`, table: 'sales', body: `v05 body ${seq}`,
    });
  }
  return rows;
}

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
    v: 0, table, dev: ['pos-01'], seqB: rows[0].seq,
    seqD: rows.map((r, i) => (i === 0 ? 0 : r.seq - rows[i - 1].seq)),
    tsB: rows[0].ts,
    tsD: rows.map((r, i) => (i === 0 ? 0 : r.ts - rows[i - 1].ts)),
    ids: rows.map((r) => r.id), devI: rows.map(() => 0), pool, runs,
  };
  const body = deflateSync(Buffer.from(JSON.stringify(frame), 'utf8'));
  const h = Buffer.alloc(64);
  h.write('UMK1', 0, 'ascii');
  h.writeUInt16LE(V05_HEADER_VER, 4);
  h.writeUInt8(CODEC_DEFLATE, 6);
  h.writeUInt8(0, 7);
  h.writeUInt32LE(fnv1a32(table) >>> 0, 8);
  h.writeBigUInt64LE(BigInt(rows[0].seq), 12);
  h.writeBigUInt64LE(BigInt(rows[rows.length - 1].seq), 20);
  h.writeBigInt64LE(BigInt(rows[0].ts), 28);
  h.writeBigInt64LE(BigInt(rows[rows.length - 1].ts), 36);
  h.writeUInt32LE(rows.length, 44);
  h.writeUInt32LE(crc32c(body) >>> 0, 48);
  h.writeUInt32LE(0, 52);
  h.writeUInt32LE(body.length, 56);
  h.writeUInt32LE(0, 60);
  return Buffer.concat([h, body]);
}

function buildV05Archive(outDir: string): { ids: string[]; sha: Map<string, string> } {
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const ids: string[] = [];
  const sha = new Map<string, string>();
  const entries: Array<Record<string, unknown>> = [];
  for (const rows of [v05Rows(1, 3), v05Rows(4, 3)]) {
    const bytes = buildV05Chunk('sales', rows);
    const digest = sha256hex(bytes);
    const pad = (n: number): string => String(n).padStart(8, '0');
    const name = `sales-${pad(rows[0].seq)}-${pad(rows[rows.length - 1].seq)}-${digest.slice(0, 8)}.chk`;
    writeFileSync(join(warm, name), bytes);
    sha.set(name, digest);
    for (const r of rows) ids.push(r.id);
    entries.push({
      file: name, table: 'sales', seqMin: rows[0].seq, seqMax: rows[rows.length - 1].seq,
      tsMin: rows[0].ts, tsMax: rows[rows.length - 1].ts, rows: rows.length,
      bytes: bytes.length, sha256: digest, crc32c: crc32c(bytes.subarray(64)) >>> 0,
      sealedBy: 'molt-0.5',
    });
  }
  const payload = `${JSON.stringify({ version: 0, createdAt: '2024-01-01T00:00:00.000Z', chunks: entries }, null, 1)}\n`;
  writeFileSync(join(outDir, 'manifest.json'), payload);
  writeFileSync(join(outDir, 'manifest.bak.json'), payload);
  return { ids, sha };
}

function manifestBytes(outDir: string): string {
  return `${readFileSync(join(outDir, 'manifest.json'), 'utf8')}|${readFileSync(join(outDir, 'manifest.bak.json'), 'utf8')}`;
}

describe('molt archive migrator', () => {
  it('dry-run reports the old archive without writing', { timeout: 30_000 }, () => {
    const outDir = join(scratch('migrate-dry'), 'archive');
    buildV05Archive(outDir);
    const before = manifestBytes(outDir);
    const plan = planMigration(outDir);
    assert.equal(plan.needs, true);
    assert.equal(plan.version, 0);
    assert.equal(plan.stale.length, 2);
    const res = migrate(outDir, { dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(res.needs, true);
    assert.equal(res.backup, null);
    assert.equal(manifestBytes(outDir), before);
    assert.equal(existsSync(join(outDir, 'manifest.pre-migrate.json')), false);
    assert.equal(needsMigration(outDir), true);
  });

  it('apply migrates old to new, keeps history, stays idempotent', { timeout: 30_000 }, () => {
    const outDir = join(scratch('migrate-apply'), 'archive');
    const { ids, sha } = buildV05Archive(outDir);
    const res = migrate(outDir);
    assert.equal(res.dryRun, false);
    assert.equal(res.migrated, 2);
    assert.ok(res.backup !== null && existsSync(res.backup));
    // Backup holds the old v0 payload.
    const backup = JSON.parse(readFileSync(res.backup as string, 'utf8')) as { version: number };
    assert.equal(backup.version, 0);
    // New manifest is v1 with full index fields and a valid envelope crc.
    const { manifest } = loadManifest(outDir);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.chunks.length, 2);
    assert.equal(manifest.crc32c, manifestCrc(manifest));
    assert.ok(Array.isArray(manifest.cold) && Array.isArray(manifest.shards));
    for (const e of manifest.chunks) {
      assert.equal(typeof e.dictId, 'number');
      assert.equal(typeof e.codec, 'number');
      assert.ok(e.minKey.length > 0 && e.maxKey.length > 0);
      assert.ok(e.bloom.length > 0);
      // History untouched: chunk bytes still hash to the sealed sha.
      assert.equal(sha256hex(readFileSync(join(outDir, 'warm', e.file))), sha.get(e.file));
      assert.equal(e.seqMin >= 1 && e.seqMax <= 6, true);
    }
    // Old rows still findable and the archive verifies clean.
    for (const id of ids) {
      assert.equal(findTrx({ outDir, trxId: id }).row.id, id);
    }
    assert.equal(verifyFull(outDir).ok, true);
    // Idempotent rerun: clean plan, no rewrite.
    const again = migrate(outDir);
    assert.equal(again.migrated, 0);
    assert.equal(again.needs, false);
    assert.equal(planMigration(outDir).reason, 'already v1');
    assert.doesNotThrow(() => assertMigrated(outDir));
  });
  it('downgrade guard refuses old manifests without corrupting', { timeout: 30_000 }, () => {
    const outDir = join(scratch('migrate-guard'), 'archive');
    buildV05Archive(outDir);
    const before = manifestBytes(outDir);
    assert.throws(() => assertMigrated(outDir), /needs migration/);
    assert.equal(manifestBytes(outDir), before);
  });

  it('guarded writers refuse old manifests until migrated', { timeout: 30_000 }, async () => {
    const dir = scratch('migrate-ship-guard');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    buildV05Archive(outDir);
    await assert.rejects(ship({ outDir, relayDir, baseDelayMs: 1 }), /needs migration/);
    migrate(outDir);
    const r = await ship({ outDir, relayDir, baseDelayMs: 1 });
    assert.equal(r.sent.length, 2);
  });
});
