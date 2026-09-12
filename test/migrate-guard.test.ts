// molt migrate-guard: repairAll + restore-from-cold refuse downgrade-writes
// on an old manifest; seal re-exposes fresh listings (find-cache pin).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { crc32c, sha256hex } from '../src/chunk.js';
import { needsMigration, requireMigrated } from '../src/migrate.js';
import { repairAll } from '../src/verify.js';
import { scratch } from './util.js';

function buildV0Archive(outDir: string): void {
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const entries: Array<Record<string, unknown>> = [];
  for (const seqBase of [1, 4]) {
    const body = Buffer.from(`row-${seqBase}`, 'utf8');
    const bytes = Buffer.concat([Buffer.alloc(64), body]);
    const digest = sha256hex(bytes);
    const pad = (n: number): string => String(n).padStart(8, '0');
    const name = `events-${pad(seqBase)}-${pad(seqBase + 2)}-${digest.slice(0, 8)}.chk`;
    writeFileSync(join(warm, name), bytes);
    entries.push({
      file: name, table: 'events', seqMin: seqBase, seqMax: seqBase + 2,
      tsMin: 1, tsMax: 2, rows: 1, bytes: bytes.length, sha256: digest,
      crc32c: crc32c(body) >>> 0, sealedBy: 'molt-0.5',
    });
  }
  const payload = `${JSON.stringify({ version: 0, createdAt: '2024-01-01T00:00:00.000Z', chunks: entries }, null, 1)}\n`;
  writeFileSync(join(outDir, 'manifest.json'), payload);
  writeFileSync(join(outDir, 'manifest.bak.json'), payload);
}

function manifestBytes(outDir: string): string {
  return `${readFileSync(join(outDir, 'manifest.json'), 'utf8')}|${readFileSync(join(outDir, 'manifest.bak.json'), 'utf8')}`;
}

describe('molt migrate-guard (repair/restore)', () => {
  it('repairAll refuses an old manifest without writing', { timeout: 30_000 }, () => {
    const dir = scratch('migrate-guard-repair');
    const outDir = join(dir, 'archive');
    const relayDir = join(dir, 'relay');
    mkdirSync(relayDir, { recursive: true });
    buildV0Archive(outDir);
    assert.equal(needsMigration(outDir), true);
    const before = manifestBytes(outDir);
    assert.throws(() => repairAll(outDir, relayDir), /needs migration/);
    assert.equal(manifestBytes(outDir), before);
  });

  it('restore-from-cold guard: requireMigrated refuses the same old shape', { timeout: 30_000 }, () => {
    // restoreFromCold (bin/moltarc.ts) calls requireMigrated(outDir) after
    // its read-only dry-run plan and before any warm/dict/manifest write;
    // pin that contract here since bin entry points are not importable.
    const outDir = join(scratch('migrate-guard-restore'), 'archive');
    buildV0Archive(outDir);
    assert.throws(() => requireMigrated(outDir), /needs migration/);
  });
});
