// molt gc — orphan sweep + status meter + reserve-space guard.
// Orphan = warm/*.chk file with refcount 0 in the manifest (not referenced
// by any manifest entry). Sweep defaults to dry-run: lists orphans, deletes
// nothing unless dryRun:false is passed explicitly.
import { existsSync, mkdirSync, readdirSync, statSync, statfsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { loadManifest } from './manifest.js';
import { readRelayIndex } from './ship.js';

// Seal refuses below this much free space so it never half-writes a chunk,
// watermark, or manifest copy.
export const RESERVE_BYTES = 50 * 1024 * 1024;

export function freeSpaceBytes(dir: string): number {
  try {
    const st = statfsSync(dir);
    return Number(st.bfree) * Number(st.bsize);
  } catch {
    // statfs unavailable (or dir missing): assume space, seal proceeds.
    return Number.MAX_SAFE_INTEGER;
  }
}

export function checkReserve(dir: string, free?: number): void {
  const target = existsSync(dir) ? dir : join(dir, '..');
  const avail = free ?? freeSpaceBytes(target);
  if (avail < RESERVE_BYTES) {
    throw new Error(
      `seal refused: only ${avail} bytes free, need 50MB reserve (free up space and retry)`,
    );
  }
}

export interface SweepOpts {
  dryRun?: boolean; // default true
}

export interface SweepResult {
  orphans: string[];
  removed: string[];
  bytesReclaimed: number;
  dryRun: boolean;
  chunks: number;
  bytes: number;
}

export function sweep(outDir: string, opts: SweepOpts = {}): SweepResult {
  const dryRun = opts.dryRun ?? true;
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const { manifest } = loadManifest(outDir);
  // Refcount over manifest entries; a disk file with 0 refs is an orphan.
  const refs = new Map<string, number>();
  for (const e of manifest.chunks) refs.set(e.file, (refs.get(e.file) ?? 0) + 1);
  let chunks = 0;
  let bytes = 0;
  const orphans: string[] = [];
  let orphanBytes = 0;
  for (const f of readdirSync(warm).filter((f: string) => f.endsWith('.chk')).sort()) {
    try {
      const st = statSync(join(warm, f));
      chunks++;
      bytes += st.size;
      if ((refs.get(f) ?? 0) === 0) {
        orphans.push(f);
        orphanBytes += st.size;
      }
    } catch { /* raced delete: ignore */ }
  }
  const removed: string[] = [];
  let bytesReclaimed = 0;
  if (!dryRun) {
    for (const f of orphans) {
      try {
        const st = statSync(join(warm, f));
        unlinkSync(join(warm, f));
        removed.push(f);
        bytesReclaimed += st.size;
      } catch { /* raced delete: ignore */ }
    }
  } else {
    bytesReclaimed = orphanBytes;
  }
  return { orphans, removed, bytesReclaimed, dryRun, chunks, bytes };
}

export interface StatusInfo {
  chunks: number;
  bytes: number;
  unacked: number;
  orphans: number;
  orphanBytes: number;
}

export function statusInfo(outDir: string, relayDir?: string): StatusInfo {
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const { manifest } = loadManifest(outDir);
  const refs = new Set(manifest.chunks.map((e) => e.file));
  let bytes = 0;
  for (const e of manifest.chunks) bytes += e.bytes;
  let orphans = 0;
  let orphanBytes = 0;
  try {
    for (const f of readdirSync(warm).filter((f: string) => f.endsWith('.chk'))) {
      if (!refs.has(f)) {
        orphans++;
        try { orphanBytes += statSync(join(warm, f)).size; } catch { /* ignore */ }
      }
    }
  } catch { /* no warm dir entries */ }
  let unacked: number;
  if (!relayDir) {
    unacked = manifest.chunks.length;
  } else {
    try {
      const remote = readRelayIndex(relayDir);
      const have = new Set(Object.keys(remote.chunks));
      unacked = manifest.chunks.filter((e) => !have.has(e.sha256)).length;
    } catch {
      unacked = manifest.chunks.length;
    }
  }
  return { chunks: manifest.chunks.length, bytes, unacked, orphans, orphanBytes };
}
