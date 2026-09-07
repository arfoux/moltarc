// moltarc find — prune by min/max, bloom check, single-chunk fetch+verify, sparse index.
// Shard-aware fast path: persisted sparse.json picks candidate files without a
// full-manifest parse, then only the months holding candidates load from
// manifest-YYYY-MM.json. Missing sidecars fall back to the root manifest.
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { decodeChunk, decodeHeader, fnv1a32, DICT_FLAG } from './chunk.js';
import type { HotRow } from './chunk.js';
import { loadDictFor } from './dict.js';
import { bloomCheck, loadManifest, loadShard, loadSparseIndex, BLOOM_BITS } from './manifest.js';
import type { ChunkEntry, ColdSegment, Manifest, ManifestShard, SparseDisk } from './manifest.js';
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
  // Shard fast path only: sidecars loaded vs months skipped by the sparse jump.
  shardsLoaded?: number;
  shardsPruned?: number;
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
const manifestCache = new Map<string, { mtimeMs: number; size: number; seq: number; manifest: Manifest; source: 'primary' | 'backup' | 'rebuilt' }>();
// Dict files are content-hash addressed and immutable; cache hits only
// (misses stay uncached so a later-sealed dict is still discovered).
const dictCache = new Map<string, Buffer>();
// Persisted sparse + shard sidecars keyed by file stat plus content seq,
// same stability deal as the manifest cache: reseal rewrites invalidate,
// repeat finds hit memory.
const sparseCache = new Map<string, { mtimeMs: number; size: number; seq: number; sparse: SparseDisk | null; cold: ColdSegment[]; total: number; quarantined: number }>();
const shardCache = new Map<string, { mtimeMs: number; size: number; seq: number; shard: ManifestShard | null }>();
export function clearFindCaches(): void {
  manifestCache.clear();
  dictCache.clear();
  sparseCache.clear();
  shardCache.clear();
}

// File stat for cache validation: missing files hash as (-1, -1) so the
// absent-sidecar entry stays cached instead of re-statting every query.
function statKey(p: string): { mtimeMs: number; size: number } {
  try {
    const st = statSync(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { mtimeMs: -1, size: -1 };
  }
}

function loadSparseCached(outDir: string): { sparse: SparseDisk | null; cold: ColdSegment[]; total: number; quarantined: number } {
  const primary = join(outDir, 'sparse.json');
  const { mtimeMs, size } = statKey(primary);
  const hit = sparseCache.get(outDir);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit;
  const loaded = loadSparseIndex(outDir);
  const seq = loaded ? loaded.sparse.seq : 0;
  const entry = loaded
    ? { mtimeMs, size, seq, sparse: loaded.sparse, cold: loaded.sparse.cold ?? [], total: loaded.sparse.total, quarantined: loaded.sparse.quarantined }
    : { mtimeMs, size, seq, sparse: null, cold: [], total: 0, quarantined: 0 };
  return entry;
}

function loadShardCached(outDir: string, month: string): ManifestShard | null {
  const file = join(outDir, `manifest-${month}.json`);
  const { mtimeMs, size } = statKey(file);
  const cacheId = `${outDir}\n${month}`;
  const hit = shardCache.get(cacheId);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.shard;
  const shard = loadShard(outDir, month);
  const seq = shard?.seq ?? 0;
  shardCache.set(cacheId, { mtimeMs, size, seq, shard });
  return shard;
}
// Sparse-level prune over persisted rows (no bloom here): binary-search the
// first entry with minKey > trxId, prune the tail, then drop head rows whose
// maxKey misses. Unknown-range rows stay candidates. Returns candidate files
// plus the min/max prune count; bloom misses resolve after the shard load.
export function sparseCandidateFiles(
  entries: { file: string; minKey: string; maxKey: string }[],
  trxId: string,
): { files: string[]; pruned: number } {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const k = entries[mid].minKey;
    if (!k || k <= trxId) lo = mid + 1;
    else hi = mid;
  }
  let pruned = entries.length - lo;
  const files: string[] = [];
  for (let i = 0; i < lo; i++) {
    const e = entries[i];
    if (e.minKey && e.maxKey && trxId > e.maxKey) {
      pruned++;
      continue;
    }
    files.push(e.file);
  }
  return { files, pruned };
}

function loadManifestCached(outDir: string): { manifest: Manifest; source: 'primary' | 'backup' | 'rebuilt' } {
  const primary = join(outDir, 'manifest.json');
  const pre = statKey(primary);
  const hit = manifestCache.get(outDir);
  if (hit && hit.mtimeMs === pre.mtimeMs && hit.size === pre.size) return hit;
  const loaded = loadManifest(outDir);
  // Re-stat: the rebuilt path may have rewritten the primary underneath us.
  const cur = statKey(primary);
  const seq = typeof loaded.manifest.seq === 'number' && Number.isFinite(loaded.manifest.seq) ? loaded.manifest.seq : 0;
  const entry = { mtimeMs: cur.mtimeMs, size: cur.size, seq, manifest: loaded.manifest, source: loaded.source };
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

// Cap on a decoded bloom bitset: scaled bitsets grow with rows, but anything
// past 1MB (8M bits, ~800k rows at 1% fp) is a bomb or garbage. Over-cap and
// short/truncated bitsets fail OPEN (must fetch): a bad bloom must never
// prune a row the chunk actually holds.
export const BLOOM_MAX_BYTES = 1 << 20;

export function bloomCheckScaled(bloomB64: string, id: string): boolean {
  if (!bloomB64) return true; // header-only rebuild: no bloom, must fetch
  const bits = Buffer.from(bloomB64, 'base64');
  if (bits.length === 0) return true; // corrupt base64: fail open, must fetch
  if (bits.length > BLOOM_MAX_BYTES) return true; // bomb bitset: fail open, never probe it
  if (bits.length * 8 === BLOOM_BITS) return bloomCheck(bloomB64, id); // legacy fast path
  const nbits = bits.length * 8;
  if (nbits < BLOOM_BITS) return true; // short/truncated bitset: fail open, must fetch
  for (let k = 0; k < 3; k++) {
    const bit = hashN(k, id) % nbits;
    const b = bits[bit >> 3] as number | undefined;
    if (b === undefined) return true; // short buffer: fail open, must fetch
    if ((b & (1 << (bit & 7))) === 0) return false;
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

// Shard-resolved warm index: sparse.json picks candidate files with no
// full-manifest parse, then only candidate months load from their sidecars.
// Null on any stale/missing sidecar so the caller keeps root behavior.
function tryShardIndex(outDir: string, trxId: string): {
  hit: ChunkEntry[]; pruned: number; shardsLoaded: number; shardsPruned: number; cold: ColdSegment[];
} | null {
  const { sparse, cold, total, quarantined } = loadSparseCached(outDir);
  if (!sparse) return null;
  const { files } = sparseCandidateFiles(sparse.entries, trxId);
  const wantFiles = new Set(files);
  const monthOf = new Map<string, string>();
  const allMonths = new Set<string>();
  for (const e of sparse.entries) {
    monthOf.set(e.file, e.month);
    allMonths.add(e.month);
  }
  const months = new Set<string>();
  for (const f of wantFiles) {
    const month = monthOf.get(f);
    if (!month) return null; // sparse/file skew: stay on root
    months.add(month);
  }
  const loaded: ChunkEntry[] = [];
  for (const month of months) {
    const shard = loadShardCached(outDir, month);
    if (!shard) return null;
    if (shard.seq !== sparse.seq) return null; // reseal raced the sidecars
    for (const e of shard.chunks) loaded.push(e);
  }
  const loadedFiles = new Set(loaded.map((e) => e.file));
  for (const f of wantFiles) {
    if (!loadedFiles.has(f)) return null; // shard skew: stay on root
  }
  const { hit, pruned: prunedWithin } = candidates(loaded, trxId);
  const pruned = quarantined + (total - quarantined - loaded.length) + prunedWithin;
  return { hit, pruned, shardsLoaded: months.size, shardsPruned: allMonths.size - months.size, cold };
}

export function findTrx(opts: FindOpts): FindResult {
  const dir = opts.chunkDir ?? join(opts.outDir, 'warm');
  const dictDir = join(dir, '..', 'dicts');
  const fast = tryShardIndex(opts.outDir, opts.trxId);
  if (fast) {
    let fetched = 0;
    let skippedMissing = 0;
    for (const e of fast.hit) {
      const full = join(dir, e.file);
      if (!existsSync(full)) { skippedMissing++; continue; }
      // Single-chunk fetch: read + verify (crc inside decodeChunk) + decode.
      const buf = readFileSync(full);
      const dict = (decodeHeader(buf).flags & DICT_FLAG) !== 0 ? loadDictCached(dictDir, e.dictId) : undefined;
      const { rows } = decodeChunk(buf, dict);
      fetched++;
      const row = rows.find((r) => r.id === opts.trxId);
      if (row) {
        return {
          row, chunk: e.file, chunksFetched: fetched, chunksPruned: fast.pruned, skippedMissing,
          shardsLoaded: fast.shardsLoaded, shardsPruned: fast.shardsPruned,
        };
      }
    }
    throw new Error(`trx ${opts.trxId} not found (${fetched} chunk(s) fetched, ${fast.pruned} pruned, ${skippedMissing} missing)`);
  }
  const { manifest } = loadManifestCached(opts.outDir);
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
  const fast = tryShardIndex(opts.outDir, opts.trxId);
  if (fast) return scanCold(opts, fast.hit, fast.pruned, fast.cold, fast.shardsLoaded, fast.shardsPruned);
  const { manifest } = loadManifestCached(opts.outDir);
  const { hit, pruned } = candidates(manifest.chunks, opts.trxId);
  return scanCold(opts, hit, pruned, manifest.cold ?? []);
}

// Shared tar scan for both paths: the warm index above already resolved the
// candidate chunks, so this only decodes the narrowed cold segments.
function scanCold(
  opts: FindColdOpts,
  hit: ChunkEntry[],
  pruned: number,
  segs: ColdSegment[],
  shardsLoaded?: number,
  shardsPruned?: number,
): FindResult {
  const coldDir = opts.coldDir ?? join(opts.outDir, 'cold');
  const dictDir = join(opts.chunkDir ?? join(opts.outDir, 'warm'), '..', 'dicts');
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
      if (row) return { row, chunk: m.name, chunksFetched: fetched, chunksPruned: pruned, skippedMissing, shardsLoaded, shardsPruned };
    }
  }
  throw new Error(
    `trx ${opts.trxId} not found in cold (${fetched} member(s) fetched, ${pruned} pruned, ${skippedMissing} missing)`,
  );
}
