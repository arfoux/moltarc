// moltarc verify — hash verify, quarantine 1 bad chunk without total loss, repair-by-hash.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { crc32c, decodeHeader, HEADER_SIZE, sha256hex } from './chunk.js';
import { loadManifest, saveManifestAtomic, scanChunk } from './manifest.js';
import type { ChunkEntry, Manifest } from './manifest.js';
import { readRelayIndex } from './ship.js';
export interface VerifyItem {
  file: string;
  ok: boolean;
  sha256: string;
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  items: VerifyItem[];
  bad: string[];
}

export function verifyChunk(full: string): VerifyItem {
  const name = full.split(/[\\/]/).pop() ?? full;
  try {
    const buf = readFileSync(full);
    const header = decodeHeader(buf);
    const body = buf.subarray(HEADER_SIZE, HEADER_SIZE + header.bodyLen);
    if (body.length !== header.bodyLen) throw new Error('truncated body');
    if (crc32c(body) !== header.crc32c) throw new Error('crc32c mismatch');
    return { file: name, ok: true, sha256: sha256hex(buf) };
  } catch (err) {
    return { file: name, ok: false, sha256: '', error: (err as Error).message };
  }
}

export function verifyAll(outDir: string): VerifyResult {
  const { manifest } = loadManifest(outDir);
  const items = manifest.chunks.map((e) => verifyChunk(join(outDir, 'warm', e.file)));
  const bad = items.filter((i) => !i.ok).map((i) => i.file);
  return { ok: bad.length === 0, items, bad };
}

// Atomic chunk write: tmp + fsync + rename + dir fsync. A crash lands on the
// old bytes or the new bytes, never a torn half-write. No direct overwrite.
function fsyncFile(p: string): void {
  const fd = openSync(p, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncChunkDir(p: string): void {
  try {
    const fd = openSync(p, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* Windows: dir fsync unsupported, rename is enough */ }
}

function writeChunkAtomic(dest: string, data: Buffer): void {
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  fsyncFile(tmp);
  renameSync(tmp, dest);
  fsyncChunkDir(dirname(dest));
}

// Strict manifest load for quarantine/repair: primary, then backup, else throw.
// Never auto-rebuilds: a lost manifest must show, not silently heal.
function loadManifestStrict(outDir: string): Manifest {
  const primary = parseManifestCopy(join(outDir, 'manifest.json'));
  if (primary) {
    if (!Array.isArray(primary.cold)) primary.cold = [];
    return primary;
  }
  const backup = parseManifestCopy(join(outDir, 'manifest.bak.json'));
  if (backup) {
    if (!Array.isArray(backup.cold)) backup.cold = [];
    return backup;
  }
  throw new Error(`no readable manifest copy in ${outDir}`);
}

// Quarantine exactly the bad chunk; every other chunk stays readable.
export function quarantine(outDir: string, file: string): void {
  const manifest = loadManifestStrict(outDir);
  const warm = join(outDir, 'warm');
  const qdir = join(outDir, 'quarantine');
  mkdirSync(qdir, { recursive: true });
  const src = join(warm, file);
  if (existsSync(src)) renameSync(src, join(qdir, file));
  const entry = manifest.chunks.find((e) => e.file === file);
  if (entry) {
    entry.quarantined = true;
    saveManifestAtomic(outDir, manifest);
  }
}

// Repair by content hash: relay holds the good bytes under the same sha256.
// Lookup is by manifest sha256 through the relay index (ship target layout);
// plain filename under relay/chunks is the fallback for index-less relays.
function fetchRelayBytes(relayDir: string, entry: ChunkEntry): Buffer {
  let relayFile = join(relayDir, 'chunks', entry.file);
  const mapped = readRelayIndex(relayDir).chunks[entry.sha256];
  if (mapped) relayFile = join(relayDir, 'chunks', mapped);
  if (!existsSync(relayFile)) throw new Error(`relay has no copy of ${entry.file}`);
  const good = readFileSync(relayFile);
  if (sha256hex(good) !== entry.sha256) throw new Error('relay copy hash differs from manifest');
  return good;
}

export function repairByHash(outDir: string, relayDir: string, file: string): void {
  const manifest = loadManifestStrict(outDir);
  const entry = manifest.chunks.find((e) => e.file === file);
  if (!entry) throw new Error(`unknown chunk ${file}`);
  const good = fetchRelayBytes(relayDir, entry);
  const dest = join(outDir, 'warm', file);
  writeChunkAtomic(dest, good);
  const check = verifyChunk(dest);
  if (!check.ok) throw new Error(`repaired chunk still bad: ${check.error}`);
  // Refill crc/bloom/minmax/rows from the fetched bytes: a quarantined stub
  // carries none, so the entry must be re-scanned, not left blank.
  const fresh = scanChunk(dest, entry.file, join(outDir, 'dicts'));
  Object.assign(entry, fresh);
  delete entry.quarantined;
  saveManifestAtomic(outDir, manifest);
}

export type ChunkStatus = 'OK' | 'CORRUPT' | 'MISSING' | 'QUARANTINED';

export interface FullVerifyItem {
  file: string;
  status: ChunkStatus;
  reason?: string;
}

export interface ManifestCheck {
  ok: boolean;
  source: 'primary' | 'backup' | 'none';
  chunks: number;
  detail: string;
}

export interface ChainBreak {
  table: string;
  prev: string;
  next: string;
}

export interface VerifyFullResult {
  ok: boolean;
  manifest: ManifestCheck;
  items: FullVerifyItem[];
  chain: ChainBreak[];
  bad: string[];
}

export interface RepairFailure {
  file: string;
  error: string;
}

export interface RepairResult {
  ok: boolean;
  repaired: string[];
  failed: RepairFailure[];
  verify: VerifyFullResult;
}

// Read-only manifest check: both copies must parse with sane entries.
// Primary is the copy of record; backup-only means the sig walk failed.
// Never auto-rebuilds: a lost manifest must show, not silently heal.
function parseManifestCopy(p: string): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as Manifest;
    if (typeof m.version !== 'number' || !Array.isArray(m.chunks)) return null;
    for (const e of m.chunks) {
      if (typeof e.file !== 'string' || !e.file) return null;
      if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return null;
      if (typeof e.crc32c !== 'number') return null;
    }
    return m;
  } catch {
    return null;
  }
}

// Chunk filenames carry their own link: table-seqMin-seqMax-sha8.
// Table part is sanitized at seal time, so only seq range + content hash link back.
const NAME_LINK = /-(\d{8})-(\d{8})-([0-9a-f]{8})\.chk$/;

function checkOne(outDir: string, entry: ChunkEntry): FullVerifyItem {
  if (entry.quarantined) return { file: entry.file, status: 'QUARANTINED', reason: 'quarantined, needs repair' };
  const full = join(outDir, 'warm', entry.file);
  if (!existsSync(full)) return { file: entry.file, status: 'MISSING', reason: 'no warm file for manifest entry' };
  let buf: Buffer;
  try {
    buf = readFileSync(full);
  } catch (err) {
    return { file: entry.file, status: 'CORRUPT', reason: `unreadable: ${(err as Error).message}` };
  }
  let header;
  try {
    header = decodeHeader(buf);
  } catch (err) {
    return { file: entry.file, status: 'CORRUPT', reason: `bad header: ${(err as Error).message}` };
  }
  const body = buf.subarray(HEADER_SIZE, HEADER_SIZE + header.bodyLen);
  if (body.length !== header.bodyLen) return { file: entry.file, status: 'CORRUPT', reason: 'truncated body' };
  if (crc32c(body) !== header.crc32c) return { file: entry.file, status: 'CORRUPT', reason: 'crc32c mismatch' };
  if (header.crc32c !== entry.crc32c) return { file: entry.file, status: 'CORRUPT', reason: 'manifest crc differs from header' };
  if (sha256hex(buf) !== entry.sha256) return { file: entry.file, status: 'CORRUPT', reason: 'sha256 differs from manifest' };
  const link = NAME_LINK.exec(entry.file);
  if (!link) return { file: entry.file, status: 'CORRUPT', reason: 'filename link missing' };
  const [, seqMin, seqMax, sha8] = link;
  if (Number(seqMin) !== entry.seqMin || Number(seqMax) !== entry.seqMax || sha8 !== entry.sha256.slice(0, 8)) {
    return { file: entry.file, status: 'CORRUPT', reason: 'filename link mismatch' };
  }
  return { file: entry.file, status: 'OK' };
}

// Hash-chain links: per table, ordered chunks must continue prev.seqMax + 1.
// A gap means a lost or forgotten chunk in the middle of claimed history.
function checkChain(entries: ChunkEntry[]): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  const byTable = new Map<string, ChunkEntry[]>();
  for (const e of entries) {
    if (e.quarantined || e.rows === 0 || e.seqMax === 0) continue;
    const arr = byTable.get(e.table);
    if (arr) arr.push(e);
    else byTable.set(e.table, [e]);
  }
  for (const [table, list] of byTable) {
    list.sort((a, b) => a.seqMin - b.seqMin || (a.file < b.file ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      if (list[i].seqMin !== list[i - 1].seqMax + 1) {
        breaks.push({ table, prev: list[i - 1].file, next: list[i].file });
      }
    }
  }
  return breaks;
}

// Full walk: manifest copies, per-chunk crc + sha against the manifest,
// filename links, then hash-chain continuity. Read-only, exit-code source.
export function verifyFull(outDir: string): VerifyFullResult {
  const primary = parseManifestCopy(join(outDir, 'manifest.json'));
  const backup = parseManifestCopy(join(outDir, 'manifest.bak.json'));
  const manifest: ManifestCheck = primary
    ? { ok: true, source: 'primary', chunks: primary.chunks.length, detail: `primary, ${primary.chunks.length} chunk(s)` }
    : backup
      ? { ok: false, source: 'backup', chunks: backup.chunks.length, detail: 'primary corrupt, fell back to backup' }
      : { ok: false, source: 'none', chunks: 0, detail: 'no readable manifest copy' };
  const entries = primary?.chunks ?? backup?.chunks ?? [];
  const items = entries.map((e) => checkOne(outDir, e));
  const chain = checkChain(entries);
  const bad = items.filter((i) => i.status === 'CORRUPT' || i.status === 'MISSING').map((i) => i.file);
  const pending = items.filter((i) => i.status === 'QUARANTINED').map((i) => i.file);
  const ok = manifest.ok && bad.length === 0 && pending.length === 0 && chain.length === 0;
  return { ok, manifest, items, chain, bad: [...bad, ...pending] };
}

// Re-fetch every bad chunk by hash from the relay, then re-verify clean.
export function repairAll(outDir: string, relayDir: string): RepairResult {
  const first = verifyFull(outDir);
  const repaired: string[] = [];
  const failed: RepairFailure[] = [];
  if (!first.ok && first.manifest.source !== 'none') {
    const manifest = loadManifestStrict(outDir);
    for (const item of first.items) {
      if (item.status === 'OK') continue;
      try {
        const entry = manifest.chunks.find((e) => e.file === item.file);
        if (!entry) throw new Error(`unknown chunk ${item.file}`);
        const good = fetchRelayBytes(relayDir, entry);
        const dest = join(outDir, 'warm', item.file);
        writeChunkAtomic(dest, good);
        const check = verifyChunk(dest);
        if (!check.ok) throw new Error(`repaired chunk still bad: ${check.error}`);
        const fresh = scanChunk(dest, entry.file, join(outDir, 'dicts'));
        Object.assign(entry, fresh);
        delete entry.quarantined;
        repaired.push(item.file);
      } catch (err) {
        failed.push({ file: item.file, error: (err as Error).message });
      }
    }
    if (repaired.length > 0) saveManifestAtomic(outDir, manifest);
  }
  const verify = verifyFull(outDir);
  return { ok: verify.ok && failed.length === 0, repaired, failed, verify };
}
