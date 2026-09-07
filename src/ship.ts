// moltarc ship — delta by hash, chunked resume, text-first lanes, exponential backoff.
// Relay = directory (cold side): <relay>/chunks/*.chk + index.json {sha256: file}.
// Never deletes source chunks.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { createHash, type Hash } from 'crypto';
import { join } from 'path';
import { atomicWrite } from './guard.js';
import { loadManifest } from './manifest.js';
import { requireMigrated } from './migrate.js';
import { checkReserve } from './gc.js';
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
  foto?: Record<string, string>;
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

// Fixed streaming window (1MB): the copy never holds the whole file, and the
// journal is batched to at most one write per 1MB of progress plus one extra
// on failure, so a kill always leaves a resume point without per-block fsync IO.
const JOURNAL_EVERY = 1 << 20;
const IO_WINDOW = 1 << 20;

interface ShipJournal { offset: number; sha256: string; file?: string }

// Feed h with file bytes [start, start + length) in fixed windows. Returns the
// bytes actually fed; a short return means the file shrank mid-read and the
// caller must treat the range as incomplete (the final hash compare fails loud).
function hashFdRange(h: Hash, fd: number, start: number, length: number): number {
  const buf = Buffer.alloc(Math.min(IO_WINDOW, length));
  let done = 0;
  while (done < length) {
    const n = Math.min(buf.length, length - done);
    let got = 0;
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, start + done + got);
      if (r === 0) return done;
      got += r;
    }
    h.update(buf.subarray(0, got));
    done += got;
  }
  return done;
}

// Streaming sha256 over the first `length` bytes of `path`.
function hashPrefix(path: string, length: number): string {
  const h = createHash('sha256');
  if (length <= 0) return h.digest('hex');
  const fd = openSync(path, 'r');
  try {
    hashFdRange(h, fd, 0, length);
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}


// Resumable chunked copy: partial file + offset journal survive process death.
// Streams src in fixed 1MB windows (never holds the whole file); the dst hash
// accumulates incrementally over the on-disk prefix plus each block as it
// lands, so the final compare needs no second full re-read.
export async function sendChunked(src: string, dst: string, statePath: string, opts: {
  blockBytes: number; maxRetries: number; baseDelayMs: number; failAtBytes?: number;
  sleep: (ms: number) => Promise<void>; chunkFile?: string;
}): Promise<{ bytes: number; resumed: boolean }> {
  const total = statSync(src).size;
  const hex = hashPrefix(src, total);
  let offset = 0;
  let failedOnce = false;
  try {
    const st = JSON.parse(readFileSync(statePath, 'utf8')) as ShipJournal;
    if (st.sha256 !== hex) { /* stale source: start at 0 */ }
    else if (opts.chunkFile !== undefined && st.file !== undefined && st.file !== opts.chunkFile) { /* foreign journal: start at 0 */ }
    else offset = Math.min(st.offset, total);
  } catch { /* no state: start at 0 */ }
  const resumed = offset > 0;
  mkdirSync(join(dst, '..'), { recursive: true });
  const journal = (at: number): void => {
    writeFileSync(statePath, JSON.stringify({ offset: at, sha256: hex, ...(opts.chunkFile !== undefined ? { file: opts.chunkFile } : {}) }));
  };
  let attempt = 0;
  for (;;) {
    let pos = offset;
    try {
      const fd = openSync(dst, offset === 0 ? 'w' : 'r+');
      const dstHash = createHash('sha256');
      try {
        // Append-only forward progress; the batched journal may lag the bytes
        // actually on disk, so clamp to the prefix present and hash it: resume
        // then continues exactly where the bytes stopped, not where the last
        // journal write happened to land.
        if (pos > 0) pos = hashFdRange(dstHash, fd, 0, pos);
        const srcFd = openSync(src, 'r');
        try {
          let lastJournaled = offset;
          const win = Buffer.alloc(Math.min(IO_WINDOW, total));
          while (pos < total) {
            if (opts.failAtBytes !== undefined && !failedOnce && pos >= opts.failAtBytes) {
              failedOnce = true;
              throw new Error(`injected transport failure at byte ${pos}`);
            }
            const n = Math.min(win.length, total - pos);
            let got = 0;
            while (got < n) {
              const r = readSync(srcFd, win, got, n - got, pos + got);
              if (r === 0) break; // src shrank mid-copy: final compare fails loud
              got += r;
            }
            if (got === 0) break;
            let woff = 0;
            while (woff < got) {
              if (opts.failAtBytes !== undefined && !failedOnce && pos >= opts.failAtBytes) {
                failedOnce = true;
                throw new Error(`injected transport failure at byte ${pos}`);
              }
              const end = Math.min(woff + opts.blockBytes, got);
              writeSync(fd, win.subarray(woff, end), 0, end - woff, pos);
              dstHash.update(win.subarray(woff, end));
              pos += end - woff;
              woff = end;
              if (pos - lastJournaled >= JOURNAL_EVERY) { journal(pos); lastJournaled = pos; }
            }
            if (got < n) break; // src EOF: final compare reports the short copy
          }
        } finally {
          closeSync(srcFd);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (statSync(dst).size !== total || dstHash.digest('hex') !== hex) throw new Error('post-copy hash mismatch');
      try { unlinkSync(statePath); } catch { /* state already gone */ }
      return { bytes: total, resumed };
    } catch (err) {
      // Batched journals lag landed blocks: persist progress on failure so a
      // kill or retry resumes from the bytes, not the last batch boundary.
      try { if (pos > offset) journal(pos); } catch { /* best-effort */ }
      if (++attempt > opts.maxRetries) throw err;
      const backoff = opts.baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * opts.baseDelayMs);
      await opts.sleep(backoff);
    }
  }
}

export async function ship(opts: ShipOpts): Promise<ShipResult> {
  // Downgrade guard first: refuse old manifests, but an outDir with no
  // manifest yet ships normally (nothing to migrate; loadManifest rebuilds).
  requireMigrated(opts.outDir);
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
  // Foto sidecars: opt-in via includeBlobs, lane last (after text), but within the
  // same ship call foto goes first: a ticket must never precede its painting.
  // Small foto (<1MB) copy-if-missing; large foto via resumable sendChunked.
  if (opts.includeBlobs ?? false) {
    const fotoSrcDir = join(opts.outDir, 'foto');
    let fotoNames: string[] = [];
    try { fotoNames = readdirSync(fotoSrcDir).filter((f: string) => /^[0-9a-f]{64}\.bin$/.test(f)).sort(); } catch { fotoNames = []; }
    const fotoMissing: string[] = [];
    remote.foto ??= {};
    for (const f of fotoNames) {
      const sha = f.slice(0, 64);
      if (remote.foto[sha]) continue;
      fotoMissing.push(f);
    }
    if (fotoMissing.length > 0) {
      checkReserve(opts.outDir, undefined, 'ship foto');
      const fotoDstDir = join(opts.relayDir, 'foto');
      mkdirSync(fotoDstDir, { recursive: true });
      for (const f of fotoMissing) {
        const sha = f.slice(0, 64);
        const src = join(fotoSrcDir, f);
        const dst = join(fotoDstDir, f);
        try {
          const sz = statSync(src).size;
          if (sz < 1 << 20) {
            if (!existsSync(dst)) copyFileSync(src, dst);
          } else {
            const state = join(opts.relayDir, `.ship-state-foto-${sha.slice(0, 12)}.json`);
            const r = await sendChunked(src, dst, state, { blockBytes, maxRetries: opts.maxRetries ?? 5, baseDelayMs: opts.baseDelayMs ?? 200, failAtBytes: opts.failAtBytes, sleep, chunkFile: `foto/${f}` });
            bytes += r.bytes;
          }
          for (const thumb of [`thumb-${sha}.jpg`, `thumb-${sha}.json`] as const) {
            const s = join(fotoSrcDir, thumb);
            const d = join(fotoDstDir, thumb);
            if (existsSync(s) && !existsSync(d)) copyFileSync(s, d);
          }
          if (statSync(src).size < 1 << 20) bytes += statSync(src).size;
          remote.foto[sha] = `foto/${f}`;
          sent.push(`foto/${f}`);
        } catch { skipped.push(`foto/${f}`); absent.push(`foto/${f}`); }
      }
    }
  }
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
