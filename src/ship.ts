// moltarc ship — delta by hash, chunked resume, text-first lanes, exponential backoff.
// Relay = directory (cold side): <relay>/chunks/*.chk + index.json {sha256: file}.
// Never deletes source chunks.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { join } from 'path';
import { sha256hex } from './chunk.js';
import { atomicWrite } from './guard.js';
import { loadManifest } from './manifest.js';
import { assertMigrated } from './migrate.js';
import type { ChunkEntry } from './manifest.js';

export interface ShipOpts {
  outDir: string;
  relayDir: string;
  includeBlobs?: boolean;
  blockBytes?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  failAtBytes?: number; // test seam: inject transport failure after N bytes (first attempt)
  sleep?: (ms: number) => Promise<void>;
}

export interface ShipResult {
  sent: string[];
  skipped: string[];
  missing: string[];
  bytes: number;
}

export interface RelayIndex {
  chunks: Record<string, string>;
}

function isBlobTable(table: string): boolean {
  return /blob|photo|image|thumb/i.test(table);
}

// Text-first lanes: small text tables before blob tables; blobs deferred unless asked.
export function laneOf(e: ChunkEntry): number {
  return isBlobTable(e.table) ? 1 : 0;
}

export interface ShipmentSkip {
  file: string;
  reason: 'quarantined' | 'blob-deferred' | 'already-acked';
}

export function planShipment(entries: ChunkEntry[], remote: RelayIndex, includeBlobs: boolean): { missing: ChunkEntry[]; skipped: ShipmentSkip[] } {
  const missing: ChunkEntry[] = [];
  const skipped: ShipmentSkip[] = [];
  for (const e of entries) {
    if (e.quarantined) { skipped.push({ file: e.file, reason: 'quarantined' }); continue; }
    if (!includeBlobs && laneOf(e) === 1) { skipped.push({ file: e.file, reason: 'blob-deferred' }); continue; }
    if (remote.chunks[e.sha256]) { skipped.push({ file: e.file, reason: 'already-acked' }); continue; }
    missing.push(e);
  }
  missing.sort((a, b) => laneOf(a) - laneOf(b) || a.seqMin - b.seqMin);
  return { missing, skipped };
}

export function readRelayIndex(relayDir: string): RelayIndex {
  try {
    return JSON.parse(readFileSync(join(relayDir, 'index.json'), 'utf8')) as RelayIndex;
  } catch {
    return { chunks: {} };
  }
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Resumable chunked copy: partial file + offset journal survive process death.
export async function sendChunked(src: string, dst: string, statePath: string, opts: {
  blockBytes: number; maxRetries: number; baseDelayMs: number; failAtBytes?: number;
  sleep: (ms: number) => Promise<void>; chunkFile?: string;
}): Promise<{ bytes: number; resumed: boolean }> {
  const data = readFileSync(src);
  const hex = sha256hex(data);
  let offset = 0;
  let failedOnce = false;
  try {
    const st = JSON.parse(readFileSync(statePath, 'utf8')) as { offset: number; sha256: string; file?: string };
    if (st.sha256 !== hex) { /* stale source: start at 0 */ }
    else if (opts.chunkFile !== undefined && st.file !== undefined && st.file !== opts.chunkFile) { /* foreign journal: start at 0 */ }
    else offset = Math.min(st.offset, data.length);
  } catch { /* no state: start at 0 */ }
  const resumed = offset > 0;
  mkdirSync(join(dst, '..'), { recursive: true });
  let attempt = 0;
  for (;;) {
    try {
      const fd = openSync(dst, offset === 0 ? 'w' : 'r+');
      try {
        // Append-only forward progress; journal every block for resume.
        let pos = offset;
        if (pos > 0) {
          try {
            pos = Math.min(statSync(dst).size, data.length);
          } catch { pos = offset; }
        }
        while (pos < data.length) {
          if (opts.failAtBytes !== undefined && !failedOnce && pos >= opts.failAtBytes) {
            failedOnce = true;
            throw new Error(`injected transport failure at byte ${pos}`);
          }
          const end = Math.min(pos + opts.blockBytes, data.length);
          writeSync(fd, data.subarray(pos, end), 0, end - pos, pos);
          pos = end;
          writeFileSync(statePath, JSON.stringify({ offset: pos, sha256: hex, ...(opts.chunkFile !== undefined ? { file: opts.chunkFile } : {}) }));
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const got = readFileSync(dst);
      if (sha256hex(got) !== hex) throw new Error('post-copy hash mismatch');
      try { unlinkSync(statePath); } catch { /* state already gone */ }
      return { bytes: data.length, resumed };
    } catch (err) {
      if (++attempt > opts.maxRetries) throw err;
      const backoff = opts.baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * opts.baseDelayMs);
      await opts.sleep(backoff);
    }
  }
}

export async function ship(opts: ShipOpts): Promise<ShipResult> {
  // Downgrade guard first: refuse old manifests, but an outDir with no
  // manifest yet ships normally (nothing to migrate; loadManifest rebuilds).
  if (existsSync(join(opts.outDir, 'manifest.json')) || existsSync(join(opts.outDir, 'manifest.bak.json'))) {
    assertMigrated(opts.outDir);
  }
  const { manifest } = loadManifest(opts.outDir);
  const relayChunks = join(opts.relayDir, 'chunks');
  mkdirSync(relayChunks, { recursive: true });
  const remote = readRelayIndex(opts.relayDir);
  const { missing, skipped: planned } = planShipment(manifest.chunks, remote, opts.includeBlobs ?? false);
  const skipped: string[] = planned.map((s) => s.file);
  const blockBytes = opts.blockBytes ?? 64 * 1024;
  const sleep = opts.sleep ?? sleepDefault;
  const sent: string[] = [];
  const absent: string[] = [];
  let bytes = 0;
  for (const e of missing) {
    const src = join(opts.outDir, 'warm', e.file);
    if (!existsSync(src)) { skipped.push(e.file); absent.push(e.file); continue; } // missing warm source: explicit missing entry, lane continues
    const dst = join(relayChunks, e.file);
    const state = join(opts.relayDir, `.ship-state-${e.file}-${e.sha256.slice(0, 12)}.json`);
    const r = await sendChunked(src, dst, state, {
      blockBytes,
      maxRetries: opts.maxRetries ?? 5,
      baseDelayMs: opts.baseDelayMs ?? 200,
      failAtBytes: opts.failAtBytes,
      sleep,
      chunkFile: e.file,
    });
    bytes += r.bytes;
    sent.push(e.file);
    remote.chunks[e.sha256] = e.file;
    try { unlinkSync(join(opts.relayDir, `.ship-state-${e.sha256.slice(0, 12)}.json`)); } catch { /* legacy journal name: best-effort */ }
  }
  // Atomic relay index: pid tmp + fsync + rename + dir fsync via the shared
  // guard, so a kill lands on the old index or the new one, never a torn write.
  if (sent.length > 0) atomicWrite(join(opts.relayDir, 'index.json'), `${JSON.stringify(remote, null, 1)}\n`);
  // Dictionaries are tiny, immutable, content-hashed: copy-if-missing, no resume needed.
  const dictSrc = join(opts.outDir, 'dicts');
  const dictDst = join(opts.relayDir, 'dicts');
  if (existsSync(dictSrc)) {
    mkdirSync(dictDst, { recursive: true });
    for (const f of readdirSync(dictSrc).filter((f: string) => f.endsWith('.dict'))) {
      const dst = join(dictDst, f);
      if (!existsSync(dst)) copyFileSync(join(dictSrc, f), dst);
    }
  }
  return { sent, skipped, missing: absent, bytes };
}
