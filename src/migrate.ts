// moltarc migrate — forward-only old archive to current manifest (v1).
// Reads stay tolerant (compat.md N-2 rule); WRITES must guard: call
// assertMigrated() before any mutating op so a new binary never rewrites
// an old manifest in place. Migration itself rescans warm chunks into a
// fresh v1 manifest and swaps it atomically (backup first). Chunk files
// are never touched, so history semantics (rows, seq, ts, sha) survive.
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildManifest, loadManifest, saveManifestAtomic } from './manifest.js';
import type { ChunkEntry, ColdSegment, Manifest } from './manifest.js';

export const CURRENT_MANIFEST_VERSION = 1;
export const BACKUP_NAME = 'manifest.pre-migrate.json';

export interface EntryDiff {
  file: string;
  missing: string[];
}

export interface MigrationPlan {
  needs: boolean;
  reason: string;
  version: number;
  entries: number;
  stale: EntryDiff[];
  missingCold: boolean;
  missingEnvelope: boolean;
  missingShards: boolean;
}

export interface MigrationResult extends MigrationPlan {
  dryRun: boolean;
  backup: string | null;
  migrated: number;
}

function rawManifest(outDir: string): { raw: unknown; text: string } | null {
  for (const name of ['manifest.json', 'manifest.bak.json']) {
    try {
      const text = readFileSync(join(outDir, name), 'utf8');
      return { raw: JSON.parse(text) as unknown, text };
    } catch { /* try next copy */ }
  }
  return null;
}

function entryGaps(e: ChunkEntry): string[] {
  const gaps: string[] = [];
  const r = e as unknown as Record<string, unknown>;
  if (typeof r.dictId !== 'number') gaps.push('dictId');
  if (typeof r.codec !== 'number') gaps.push('codec');
  if (typeof r.minKey !== 'string' || typeof r.maxKey !== 'string') gaps.push('minKey/maxKey');
  if (typeof r.bloom !== 'string') gaps.push('bloom');
  return gaps;
}

// Dry-run report: no disk writes. Old = version < 1, or any entry missing
// the v1 index fields, or missing cold[]/seq+crc/shards envelope.
export function planMigration(outDir: string): MigrationPlan {
  const found = rawManifest(outDir);
  if (!found || typeof found.raw !== 'object' || found.raw === null) {
    return { needs: true, reason: 'no readable manifest copy', version: -1, entries: 0, stale: [], missingCold: true, missingEnvelope: true, missingShards: true };
  }
  const m = found.raw as Manifest;
  const version = typeof m.version === 'number' ? m.version : -1;
  const chunks = Array.isArray(m.chunks) ? m.chunks : [];
  const stale: EntryDiff[] = [];
  for (const e of chunks) {
    const missing = entryGaps(e);
    if (missing.length > 0) stale.push({ file: e.file, missing });
  }
  const missingCold = !Array.isArray(m.cold);
  const missingEnvelope = typeof m.seq !== 'number' || typeof m.crc32c !== 'number';
  const missingShards = !Array.isArray(m.shards);
  const old = version < CURRENT_MANIFEST_VERSION;
  const needs = old || stale.length > 0 || missingCold || missingEnvelope || missingShards;
  const reason = !needs
    ? 'already v1'
    : old ? `manifest version ${version} < ${CURRENT_MANIFEST_VERSION} (run migrate)` : 'v1 shape incomplete (run migrate)';
  return { needs, reason, version, entries: chunks.length, stale, missingCold, missingEnvelope, missingShards };
}

export function needsMigration(outDir: string): boolean {
  return planMigration(outDir).needs;
}

// Downgrade guard: new-binary write paths MUST call this first. Refuses old
// manifests with a migrate hint and never writes, so a downgrade can neither
// corrupt nor silently half-upgrade an archive. Reads (find/verify) stay
// tolerant per docs/compat.md and intentionally bypass this guard.
export function assertMigrated(outDir: string): void {
  const plan = planMigration(outDir);
  if (plan.needs) throw new Error(`archive at ${outDir} needs migration to v${CURRENT_MANIFEST_VERSION} (${plan.reason}); run migrate before writing`);
}

// Forward migrate: dryRun reports only; apply backups the primary manifest
// bytes first, then rescans warm chunks (history-preserving: chunk files
// untouched) and atomically swaps the dual copy + sidecars. Idempotent:
// a current archive plans clean and rewrites nothing.
export function migrate(outDir: string, opts?: { dryRun?: boolean }): MigrationResult {
  const dryRun = opts?.dryRun ?? false;
  const plan = planMigration(outDir);
  const idle: MigrationResult = { ...plan, dryRun, backup: null, migrated: 0 };
  if (!plan.needs) return idle;
  if (dryRun) return idle;
  if (!existsSync(join(outDir, 'warm'))) throw new Error(`no archive at ${outDir}`);
  // Backup first: raw primary bytes so a human can roll back even if the
  // rescan below fails. Writes the backup copy only; originals untouched.
  const primary = join(outDir, 'manifest.json');
  const backupPath = join(outDir, BACKUP_NAME);
  if (!existsSync(backupPath) && existsSync(primary)) copyFileSync(primary, backupPath);
  // Preserve cold listing: buildManifest scans warm only (tars stay on disk).
  let cold: ColdSegment[] | undefined;
  try {
    const { manifest } = loadManifest(outDir);
    if (Array.isArray(manifest.cold)) cold = manifest.cold;
  } catch { /* no prior manifest readable: fresh cold[] */ }
  const fresh = buildManifest(outDir);
  fresh.version = CURRENT_MANIFEST_VERSION;
  // Keep the original seal timestamp when the old copy carries one.
  const prev = rawManifest(outDir)?.raw as { createdAt?: unknown } | null;
  if (prev && typeof prev.createdAt === 'string' && prev.createdAt.length > 0) fresh.createdAt = prev.createdAt;
  saveManifestAtomic(outDir, fresh);
  return { ...planMigration(outDir), dryRun, backup: backupPath, migrated: plan.stale.length };
}
