// moltarc find — prune by min/max, bloom check, single-chunk fetch+verify, sparse index.
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { decodeChunk, decodeHeader, fnv1a32, DICT_FLAG } from './chunk.js';
import type { HotRow } from './chunk.js';
import { loadDictFor } from './dict.js';
import { bloomCheck, loadManifest, BLOOM_BITS } from './manifest.js';
import type { ChunkEntry, Manifest } from './manifest.js';
import { readTar } from './cold.js';

export interface FindOpts {
  outDir: string;
  trxId: string;
  chunkDir?: string; // default <outDir>/warm
}

export interface FindResult {
  row: HotRow;
  chunk: string;
  chunksFetched: number;
  chunksPruned: number;
  skippedMissing: number;
}

export interface FindColdOpts extends FindOpts {
  coldDir?: string; // default <outDir>/cold
}

export interface SparseEntry {
  minKey: string;
  maxKey: string;
  file: string;
  seqMin: number;
}

// Sparse index: one min/max row per chunk; prune before any fetch.
export function buildSparseIndex(entries: ChunkEntry[]): SparseEntry[] {
  return entries
    .filter((e) => !e.quarantined && e.minKey)
    .map((e) => ({ minKey: e.minKey, maxKey: e.maxKey, file: e.file, seqMin: e.seqMin }))
    .sort((a, b) => (a.minKey < b.minKey ? -1 : a.minKey > b.minKey ? 1 : 0));
}

// --- per-process caches: no re-parse per query ---
// Manifest files are content-stable between seals; key by outDir + primary
// mtime so a reseal (rewrite) invalidates while repeat finds hit memory.
const manifestCache = new Map<string, { mtimeMs: number; manifest: Manifest; source: 'primary' | 'backup' | 'rebuilt' }>();
// Dict files are content-hash addressed and immutable; cache hits only
// (misses stay uncached so a later-sealed dict is still discovered).
const dictCache = new Map<string, Buffer>();

export function clearFindCaches(): void {
  manifestCache.clear();
  dictCache.clear();
}

function loadManifestCached(outDir: string): { manifest: Manifest; source: 'primary' | 'backup' | 'rebuilt' } {
  const primary = join(outDir, 'manifest.json');
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(primary).mtimeMs;
  } catch { /* missing primary: fall through, loadManifest picks backup/rebuilt */ }
  const hit = manifestCache.get(outDir);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const loaded = loadManifest(outDir);
  try {
    mtimeMs = statSync(primary).mtimeMs;
  } catch { /* rebuilt path rewrote it; re-stat best effort */ }
  const entry = { mtimeMs, manifest: loaded.manifest, source: loaded.source };
  manifestCache.set(outDir, entry);
  return entry;
}

function loadDictCached(dictDir: string, dictId: number): Buffer | undefined {
  const key = `${dictDir}\n${dictId >>> 0}`;
  const hit = dictCache.get(key);
  if (hit) return hit;
  const d = loadDictFor(dictDir, dictId);
  if (d) dictCache.set(key, Buffer.from(d));
  return d ?? undefined;
}

// --- scaled bloom: bits grow with estimated rows per chunk ---
// Legacy chunks are fixed BLOOM_BITS; newer chunks may carry a larger
// power-of-two bitset (>= rows*10 bits, ~1% fp with k=3). The reader must
// not assume a fixed size: mod by the actual stored bit length so old
// entries decode exactly as before and scaled entries stay correct.
export function bloomBitsForRows(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return BLOOM_BITS;
  const need = Math.ceil(rows * 10);
  let bits = BLOOM_BITS;
  while (bits < need) bits *= 2;
  return bits;
}

function hashN(seed: number, key: string): number {
  return (fnv1a32(`${seed}:${key}`) ^ fnv1a32(key.split('').reverse().join(''))) >>> 0;
}

export function bloomCheckScaled(bloomB64: string, id: string): boolean {
  if (!bloomB64) return true; // header-only rebuild: no bloom, must fetch
  const bits = Buffer.from(bloomB64, 'base64');
  if (bits.length * 8 === BLOOM_BITS) return bloomCheck(bloomB64, id); // legacy fast path
  const nbits = bits.length * 8;
  if (nbits === 0) return true;
  for (let k = 0; k < 3; k++) {
    const bit = hashN(k, id) % nbits;
    if ((bits[bit >> 3] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

function inRange(e: ChunkEntry, trxId: string): boolean {
  if (!e.minKey || !e.maxKey) return true; // unknown range: cannot prune
  return e.minKey <= trxId && trxId <= e.maxKey;
}

export function candidates(entries: ChunkEntry[], trxId: string): { hit: ChunkEntry[]; pruned: number } {
  // Sparse-index jump: sort once via buildSparseIndex, binary-search the
  // first entry with minKey > trxId, prune that whole tail without per-row
  // compares or bloom probes. Only the minKey <= trxId head gets maxKey +
  // bloom checks. Quarantined and unknown-range rows bypass the index.
  let pruned = 0;
  const unknown: ChunkEntry[] = [];
  const ranged: ChunkEntry[] = [];
  for (const e of entries) {
    if (e.quarantined) { pruned++; continue; }
    if (!e.minKey || !e.maxKey) { unknown.push(e); continue; }
    ranged.push(e);
  }
  const sparse = buildSparseIndex(ranged);
  const byFile = new Map<string, ChunkEntry>();
  for (const e of ranged) byFile.set(e.file, e);
  let lo = 0;
  let hi = sparse.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sparse[mid].minKey <= trxId) lo = mid + 1;
    else hi = mid;
  }
  pruned += sparse.length - lo; // tail: minKey > trxId, range-pruned by jump
  const hit: ChunkEntry[] = [];
  for (let i = 0; i < lo; i++) {
    const s = sparse[i];
    if (trxId > s.maxKey) { pruned++; continue; }
    const e = byFile.get(s.file);
    if (!e) { pruned++; continue; }
    if (!inRange(e, trxId)) { pruned++; continue; }
    if (!bloomCheckScaled(e.bloom, trxId)) { pruned++; continue; }
    hit.push(e);
  }
  for (const e of unknown) {
    if (!bloomCheckScaled(e.bloom, trxId)) { pruned++; continue; }
    hit.push(e);
  }
  hit.sort((a, b) => a.seqMin - b.seqMin);
  return { hit, pruned };
}

export function findTrx(opts: FindOpts): FindResult {
  const { manifest } = loadManifestCached(opts.outDir);
  const dir = opts.chunkDir ?? join(opts.outDir, 'warm');
  const dictDir = join(dir, '..', 'dicts');
  const { hit, pruned } = candidates(manifest.chunks, opts.trxId);
  let fetched = 0;
  let skippedMissing = 0;
  for (const e of hit) {
    const full = join(dir, e.file);
    if (!existsSync(full)) { skippedMissing++; continue; }
    // Single-chunk fetch: read + verify (crc inside decodeChunk) + decode.
    const buf = readFileSync(full);
    const dict = (decodeHeader(buf).flags & DICT_FLAG) !== 0 ? loadDictCached(dictDir, e.dictId) : undefined;
    const { rows } = decodeChunk(buf, dict);
    fetched++;
    const row = rows.find((r) => r.id === opts.trxId);
    if (row) return { row, chunk: e.file, chunksFetched: fetched, chunksPruned: pruned, skippedMissing };
  }
  throw new Error(`trx ${opts.trxId} not found (${fetched} chunk(s) fetched, ${pruned} pruned, ${skippedMissing} missing)`);
}

// Cold opt-in scan: warm find stays cheap; cold tar decode is O(segments)
// and deliberately loud about it. Narrows to segments holding a candidate
// chunk when the warm index yields one; fully-pruned keys skip the scan.
export function findCold(opts: FindColdOpts): FindResult {
  const { manifest } = loadManifestCached(opts.outDir);
  const { hit, pruned } = candidates(manifest.chunks, opts.trxId);
  const coldDir = opts.coldDir ?? join(opts.outDir, 'cold');
  const dictDir = join(opts.chunkDir ?? join(opts.outDir, 'warm'), '..', 'dicts');
  const segs = manifest.cold ?? [];
  const hitFiles = new Set(hit.map((e) => e.file));
  let targets: string[];
  if (hitFiles.size > 0) {
    const rel = segs.filter((s) => s.chunks.some((c) => hitFiles.has(c))).map((s) => s.file);
    targets = rel.length > 0 ? rel : segs.map((s) => s.file);
  } else if (segs.length > 0) {
    throw new Error(`trx ${opts.trxId} not found in cold (${pruned} pruned, ${segs.length} segment(s) skipped)`);
  } else {
    targets = [];
  }
  let onDisk: string[];
  try {
    onDisk = readdirSync(coldDir).filter((f: string) => f.endsWith('.tar')).sort();
  } catch {
    onDisk = [];
  }
  const wanted = new Set(targets);
  let skippedMissing = 0;
  for (const t of targets) {
    if (!onDisk.includes(t)) skippedMissing++;
  }
  console.warn(
    `findCold: scanning ${targets.length} cold segment(s) in ${coldDir} for ${opts.trxId} (tar decode over compressed members; slower than warm find)`,
  );
  let fetched = 0;
  for (const seg of onDisk) {
    if (!wanted.has(seg) && wanted.size > 0) continue;
    const buf = readFileSync(join(coldDir, seg));
    const members = readTar(buf);
    for (const m of members) {
      if (hitFiles.size > 0 && !hitFiles.has(m.name)) continue;
      const header = decodeHeader(m.data);
      const dict = (header.flags & DICT_FLAG) !== 0 ? loadDictCached(dictDir, header.dictId) : undefined;
      const { rows } = decodeChunk(Buffer.from(m.data), dict);
      fetched++;
      const row = rows.find((r) => r.id === opts.trxId);
      if (row) return { row, chunk: m.name, chunksFetched: fetched, chunksPruned: pruned, skippedMissing };
    }
  }
  throw new Error(
    `trx ${opts.trxId} not found in cold (${fetched} member(s) fetched, ${pruned} pruned, ${skippedMissing} missing)`,
  );
}
