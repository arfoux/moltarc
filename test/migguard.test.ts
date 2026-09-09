// molt migrate-guard test: every write-path entry refuses an old manifest
// in place (FAILS-pre/PASSES-post for gc apply; pins the rest), dry-runs
// stay tolerant, and migrate heals all writers. Fixture is a hand-rolled
// v0 archive (never the current writers) so it is genuinely old.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { crc32c, fnv1a32, sha256hex } from '../src/chunk.js';
import { forgetChunks, mergeCold, sweepCold } from '../src/cold.js';
import { sweep } from '../src/gc.js';
import { migrate, needsMigration } from '../src/migrate.js';
import { ship } from '../src/ship.js';
import { scratch } from './util.js';

function v05ChunkBytes(table: string, seqBase: number, count: number): { bytes: Buffer; ids: string[] } {
  const pool: string[] = [];
  const poolIdx = new Map<string, number>();
  const runs: Array<[number, number]> = [];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const seq = seqBase + i;
    const id = `trx-${String(seq).padStart(8, '0')}`;
    ids.push(id);
    const body = `v05 body ${seq}`;
    let p = poolIdx.get(body);
    if (p === undefined) { p = pool.length; poolIdx.set(body, p); pool.push(body); }
    const last = runs[runs.length - 1];
    if (last && last[0] === p) last[1]++;
    else runs.push([p, 1]);
  }
  const frame = {
    v: 0, table, dev: ['dev-01'], seqB: seqBase,
    seqD: Array.from({ length: count }, (_, i) => (i === 0 ? 0 : 1)),
    tsB: 1_700_000_000_000 + seqBase * 1000,
    tsD: Array.from({ length: count }, (_, i) => (i === 0 ? 0 : 1000)),
    ids, devI: Array.from({ length: count }, () => 0), pool, runs,
  };
  const body = deflateSync(Buffer.from(JSON.stringify(frame), 'utf8'));
  const h = Buffer.alloc(64);
  h.write('UMK1', 0, 'ascii');
  h.writeUInt16LE(0, 4); // v0 header
  h.writeUInt8(2, 6); // deflate codec
  h.writeUInt8(0, 7);
  h.writeUInt32LE(fnv1a32(table) >>> 0, 8);
  h.writeBigUInt64LE(BigInt(seqBase), 12);
  h.writeBigUInt64LE(BigInt(seqBase + count - 1), 20);
  h.writeBigInt64LE(BigInt(1_700_000_000_000 + seqBase * 1000), 28);
  h.writeBigInt64LE(BigInt(1_700_000_000_000 + (seqBase + count - 1) * 1000), 36);
  h.writeUInt32LE(count, 44);
  h.writeUInt32LE(crc32c(body) >>> 0, 48);
  h.writeUInt32LE(0, 52);
  h.writeUInt32LE(body.length, 56);
  h.writeUInt32LE(0, 60);
  return { bytes: Buffer.concat([h, body]), ids };
}

function buildV0Archive(outDir: string): { files: string[] } {
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const entries: Array<Record<string, unknown>> = [];
  const files: string[] = [];
  for (const seqBase of [1, 4]) {
    const { bytes } = v05ChunkBytes('events', seqBase, 3);
    const digest = sha256hex(bytes);
    const pad = (n: number): string => String(n).padStart(8, '0');
    const name = `events-${pad(seqBase)}-${pad(seqBase + 2)}-${digest.slice(0, 8)}.chk`;
    writeFileSync(join(warm, name), bytes);
    files.push(name);
    entries.push({
      file: name, table: 'events', seqMin: seqBase, seqMax: seqBase + 2,
      tsMin: 1_700_000_000_000 + seqBase * 1000, tsMax: 1_700_000_000_000 + (seqBase + 2) * 1000,
      rows: 3, bytes: bytes.length, sha256: digest, crc32c: crc32c(bytes.subarray(64)) >>> 0,
      sealedBy: 'molt-0.5',
    });
  }
  const payload = `${JSON.stringify({ version: 0, createdAt: '2024-01-01T00:00:00.000Z', chunks: entries }, null, 1)}\n`;
  writeFileSync(join(outDir, 'manifest.json'), payload);
  writeFileSync(join(outDir, 'manifest.bak.json'), payload);
  return { files };
}

function manifestBytes(outDir: string): string {
  return `${readFileSync(join(outDir, 'manifest.json'), 'utf8')}|${readFileSync(join(outDir, 'manifest.bak.json'), 'utf8')}`;
}

function warmListing(outDir: string): string {
  return readdirSync(join(outDir, 'warm')).sort().join(',');
}

describe('molt migrate guard (every write path)', () => {
  it('ship refuses an old manifest without writing', { timeout: 30_000 }, async () => {
    const dir = scratch('migguard-ship');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    buildV0Archive(outDir);
    assert.equal(needsMigration(outDir), true);
    const before = manifestBytes(outDir);
    await assert.rejects(ship({ outDir, relayDir, baseDelayMs: 1 }), /needs migration/);
    assert.equal(manifestBytes(outDir), before);
  });

  it('mergeCold refuses an old manifest without writing', { timeout: 30_000 }, () => {
    const outDir = join(scratch('migguard-merge'), 'archive');
    buildV0Archive(outDir);
    const before = manifestBytes(outDir);
    assert.throws(() => mergeCold(outDir), /needs migration/);
    assert.equal(manifestBytes(outDir), before);
  });

  it('sweepCold apply refuses an old manifest; dry-run still reports', { timeout: 30_000 }, () => {
    const outDir = join(scratch('migguard-sweepcold'), 'archive');
    buildV0Archive(outDir);
    const dry = sweepCold(outDir);
    assert.equal(dry.dryRun, true);
    const before = manifestBytes(outDir);
    assert.throws(() => sweepCold(outDir, { dryRun: false }), /needs migration/);
    assert.equal(manifestBytes(outDir), before);
  });

  it('forgetChunks refuses an old manifest without pruning', { timeout: 30_000 }, () => {
    const dir = scratch('migguard-forget');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    mkdirSync(relayDir, { recursive: true });
    const { files } = buildV0Archive(outDir);
    const before = manifestBytes(outDir);
    assert.throws(() => forgetChunks(outDir, [files[0]], relayDir), /needs migration/);
    assert.equal(manifestBytes(outDir), before);
  });

  it('gc apply refuses an old manifest without deleting; dry-run still reports', { timeout: 30_000 }, () => {
    const dir = scratch('migguard-gc');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    mkdirSync(relayDir, { recursive: true });
    buildV0Archive(outDir);
    const dry = sweep(outDir, { relayDir });
    assert.equal(dry.dryRun, true);
    const before = manifestBytes(outDir);
    const warmBefore = warmListing(outDir);
    assert.throws(() => sweep(outDir, { dryRun: false, relayDir }), /needs migration/);
    assert.equal(manifestBytes(outDir), before);
    assert.equal(warmListing(outDir), warmBefore);
  });

  it('migrate heals every write path', { timeout: 60_000 }, async () => {
    const dir = scratch('migguard-heal');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    buildV0Archive(outDir);
    migrate(outDir);
    assert.equal(needsMigration(outDir), false);
    assert.doesNotThrow(() => mergeCold(outDir));
    assert.doesNotThrow(() => sweepCold(outDir, { dryRun: false }));
    assert.doesNotThrow(() => sweep(outDir, { dryRun: false, relayDir }));
    const r = await ship({ outDir, relayDir, baseDelayMs: 1 });
    assert.equal(r.sent.length, 2);
  });
});
