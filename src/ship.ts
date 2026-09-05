// molt ship — delta by hash, chunked resume, text-first lanes, exponential backoff.
// Relay = directory (cold side): <relay>/chunks/*.chk + index.json {sha256: file}.
// Never deletes source chunks.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { join } from 'path';
import { sha256hex } from './chunk.js';
import { loadManifest } from './manifest.js';
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

export function planShipment(entries: ChunkEntry[], remote: RelayIndex, includeBlobs: boolean): { missing: ChunkEntry[]; skipped: string[] } {
  const missing: ChunkEntry[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    if (e.quarantined) { skipped.push(e.file); continue; }
    if (!includeBlobs && laneOf(e) === 1) { skipped.push(e.file); continue; }
    if (remote.chunks[e.sha256]) { skipped.push(e.file); continue; }
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

function saveRelayIndex(relayDir: string, idx: RelayIndex): void {
  const dest = join(relayDir, 'index.json');
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(idx, null, 1)}\n`);
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, dest);
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Resumable chunked copy: partial file + offset journal survive process death.
export async function sendChunked(src: string, dst: string, statePath: string, opts: {
  blockBytes: number; maxRetries: number; baseDelayMs: number; failAtBytes?: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ bytes: number; resumed: boolean }> {
  const data = readFileSync(src);
  let offset = 0;
  let failedOnce = false;
  try {
    const st = JSON.parse(readFileSync(statePath, 'utf8')) as { offset: number; sha256: string };
    if (st.sha256 === sha256hex(data)) offset = Math.min(st.offset, data.length);
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
        if (pos > 0) pos = Math.min(readFileSync(dst).length, data.length);
        while (pos < data.length) {
          if (opts.failAtBytes !== undefined && !failedOnce && pos >= opts.failAtBytes) {
            failedOnce = true;
            throw new Error(`injected transport failure at byte ${pos}`);
          }
          const end = Math.min(pos + opts.blockBytes, data.length);
          writeSync(fd, data.subarray(pos, end), 0, end - pos, pos);
          pos = end;
          writeFileSync(statePath, JSON.stringify({ offset: pos, sha256: sha256hex(data) }));
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const got = readFileSync(dst);
      if (sha256hex(got) !== sha256hex(data)) throw new Error('post-copy hash mismatch');
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
  const { manifest } = loadManifest(opts.outDir);
  const relayChunks = join(opts.relayDir, 'chunks');
  mkdirSync(relayChunks, { recursive: true });
  const remote = readRelayIndex(opts.relayDir);
  const { missing, skipped } = planShipment(manifest.chunks, remote, opts.includeBlobs ?? false);
  const blockBytes = opts.blockBytes ?? 64 * 1024;
  const sleep = opts.sleep ?? sleepDefault;
  const sent: string[] = [];
  let bytes = 0;
  for (const e of missing) {
    const src = join(opts.outDir, 'warm', e.file);
    if (!existsSync(src)) continue; // quarantined-away source: skip, never fail the lane
    const dst = join(relayChunks, e.file);
    const state = join(opts.relayDir, `.ship-state-${e.sha256.slice(0, 12)}.json`);
    const r = await sendChunked(src, dst, state, {
      blockBytes,
      maxRetries: opts.maxRetries ?? 5,
      baseDelayMs: opts.baseDelayMs ?? 200,
      failAtBytes: opts.failAtBytes,
      sleep,
    });
    bytes += r.bytes;
    sent.push(e.file);
    remote.chunks[e.sha256] = e.file;
    saveRelayIndex(opts.relayDir, remote);
  }
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
  return { sent, skipped, bytes };
}
