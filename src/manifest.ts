// moltarc manifest — atomic tmp+fsync+rename, dual copy, min/max+bloom, rebuild-from-filenames,
// monthly shards (manifest-YYYY-MM.json + root pointer), persisted sparse index (sparse.json).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { crc32c, decodeChunk, decodeHeader, fnv1a32, HEADER_SIZE, sha256hex, DICT_FLAG } from './chunk.js';
import { loadDictFor } from './dict.js';

export const BLOOM_BITS = 2048;
const BLOOM_BYTES = BLOOM_BITS / 8;

export interface ChunkEntry {
  file: string;
  table: string;
  seqMin: number;
  seqMax: number;
  tsMin: number;
  tsMax: number;
  rows: number;
  bytes: number;
  sha256: string;
  crc32c: number;
  dictId: number;
  codec: number;
  minKey: string;
  maxKey: string;
  bloom: string;
  quarantined?: boolean;
}

export interface ColdSegment {
  file: string;
  chunks: string[];
  bytes: number;
}

export interface ShardPointer {
  /** UTC month key, e.g. '2024-05'; matches ManifestShard.month. */
  name: string;
  /** Shard sidecar filename, e.g. 'manifest-2024-05.json'. */
  file: string;
  /** Chunk entries grouped into this month. */
  count: number;
  /** Min/max chunk key over the month's entries; '' when unknown. */
  minKey: string;
  maxKey: string;
  /** Min tsMin / max tsMax over the month's entries. */
  minTs: number;
  maxTs: number;
  /** crc32c of the shard envelope; lets readers detect shard skew. */
  crc32c: number;
}

/** Budget for the serialized pointers array inside the root manifest. */
export const MAX_SHARD_POINTER_BYTES = 2048;

export interface Manifest {
  version: number;
  createdAt: string;
  chunks: ChunkEntry[];
  cold?: ColdSegment[];
  // Monthly-shard pointer: sorted YYYY-MM months with a manifest-<month>.json
  // sidecar. Root chunks[] stays complete so old readers work untouched.
  shards?: string[];
  // Per-month stats for the shard sidecars: lets find prune whole months via
  // minKey/maxKey before loading any shard file. Optional so pre-pointer
  // archives load untouched and fall back to the root chunks[].
  pointers?: ShardPointer[];
  // Generation envelope: seq bumps on every atomic save, crc32c self-validates
  // the envelope so load can pick the best crc-valid copy. Both optional so
  // pre-envelope (v0/v1) archives still load as seq 0.
  seq?: number;
  crc32c?: number;
}

export interface ManifestShard {
  version: number;
  month: string;
  chunks: ChunkEntry[];
  seq?: number;
  crc32c?: number;
}

export interface SparseDiskEntry {
  file: string;
  minKey: string;
  maxKey: string;
  seqMin: number;
  month: string;
}

export interface SparseDisk {
  version: number;
  seq: number;
  total: number;
  quarantined: number;
  entries: SparseDiskEntry[];
  cold: ColdSegment[];
  crc32c?: number;
}

function hashN(seed: number, key: string): number {
  return (fnv1a32(`${seed}:${key}`) ^ fnv1a32(key.split('').reverse().join(''))) >>> 0;
}

export function buildBloom(ids: string[]): string {
  const bits = Buffer.alloc(BLOOM_BYTES);
  for (const id of ids) {
    for (let k = 0; k < 3; k++) {
      const bit = hashN(k, id) % BLOOM_BITS;
      bits[bit >> 3] |= 1 << (bit & 7);
    }
  }
  return bits.toString('base64');
}

export function bloomCheck(bloomB64: string, id: string): boolean {
  if (!bloomB64) return true; // header-only rebuild: no bloom, must fetch
  const bits = Buffer.from(bloomB64, 'base64');
  if (bits.length < BLOOM_BYTES) return true; // short/truncated legacy bitset: fail open, must fetch
  for (let k = 0; k < 3; k++) {
    const bit = hashN(k, id) % BLOOM_BITS;
    if ((bits[bit >> 3] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

// Editors on Windows leave a U+FEFF at byte 0; JSON.parse chokes on it.
// Strip one leading BOM on every manifest/watermark text read.
export function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readManifestText(p: string): string {
  return stripBom(readFileSync(p, 'utf8'));
}

// Canonical envelope bytes the manifest crc covers: explicit field order so
// save and load agree regardless of key insertion order on disk. shards is
// covered only when present, so pre-shard crc copies stay valid.
function envelopeBytes(m: Manifest): Buffer {
  const env: Record<string, unknown> = {
    version: m.version,
    createdAt: m.createdAt,
    chunks: m.chunks,
    cold: m.cold ?? [],
    seq: m.seq ?? 0,
  };
  if (m.shards !== undefined) env.shards = m.shards;
  if (m.pointers !== undefined) env.pointers = m.pointers;
  return Buffer.from(JSON.stringify(env), 'utf8');
}

export function manifestCrc(m: Manifest): number {
  return crc32c(envelopeBytes(m));
}

function manifestSeq(m: Manifest): number {
  return typeof m.seq === 'number' && Number.isFinite(m.seq) && m.seq > 0 ? Math.floor(m.seq) : 0;
}

// Strict copy parse: chunks must be an array, and a present crc must match.
// Pre-envelope copies (no seq/crc) stay valid as seq 0 for back-compat.
function parseManifestCopy(p: string): Manifest | null {
  try {
    const m = JSON.parse(readManifestText(p)) as Manifest;
    if (typeof m.version !== 'number' || !Array.isArray(m.chunks)) return null;
    if (typeof m.crc32c === 'number' && m.crc32c >>> 0 !== manifestCrc(m)) return null;
    return m;
  } catch {
    return null;
  }
}

// Lenient cold[] salvage for the rebuilt path: even a crc-torn copy may still
// carry a good cold listing, and the tars stay on disk either way.
function salvageCold(outDir: string): ColdSegment[] | undefined {
  for (const name of ['manifest.json', 'manifest.bak.json']) {
    try {
      const m = JSON.parse(readManifestText(join(outDir, name))) as { cold?: unknown };
      if (Array.isArray(m.cold)) return m.cold as ColdSegment[];
    } catch { /* torn beyond json: try the next copy */ }
  }
  return undefined;
}

function prevValidSeq(outDir: string): number {
  let best = 0;
  for (const name of ['manifest.json', 'manifest.bak.json']) {
    const m = parseManifestCopy(join(outDir, name));
    if (m) best = Math.max(best, manifestSeq(m));
  }
  return best;
}

function stampEnvelope(m: Manifest, baseSeq: number): void {
  const want = Math.max(manifestSeq(m), baseSeq) + 1;
  m.seq = want;
  if (!Array.isArray(m.cold)) m.cold = [];
  // Additive month pointer: union with the previous list so a month never
  // drops out of the pointer once stamped (root chunks[] is the source of
  // truth; a dangling month falls back to root at find time).
  const prevShards = Array.isArray(m.shards) ? m.shards : [];
  const prevPointers = Array.isArray(m.pointers) ? m.pointers : [];
  m.shards = [...new Set([...prevShards, ...shardMonthsFor(m.chunks)])].sort();
  m.pointers = buildShardPointers(m.chunks, m.version, want, prevPointers);
  assertShardPointersSize(m.pointers);
  m.crc32c = manifestCrc(m);
}

// --- monthly shards + persisted sparse index ---
// Shard key is the UTC month of the chunk's tsMin (tsMax fallback); zero-ts
// quarantined stubs land in 1970-01 so they stay addressable.
export function monthForTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '1970-01';
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function shardMonthForEntry(e: ChunkEntry): string {
  if (typeof e.tsMin === 'number' && e.tsMin > 0) return monthForTs(e.tsMin);
  if (typeof e.tsMax === 'number' && e.tsMax > 0) return monthForTs(e.tsMax);
  return '1970-01';
}

export function shardFileForMonth(month: string): string {
  return `manifest-${month}.json`;
}

export function shardMonthsFor(chunks: ChunkEntry[]): string[] {
  const months = new Set<string>();
  for (const e of chunks) months.add(shardMonthForEntry(e));
  return [...months].sort();
}

// Per-month rollup over the current chunks. Pointer crc32c is computed over
// the exact shard envelope saveShardSidecars writes (same version, month,
// file-sorted entries, seq), so readers can match pointer against sidecar.
// prev carries months with no current chunks forward unchanged (additive
// only); fresh months always rebuild from live entries.
export function buildShardPointers(
  chunks: ChunkEntry[],
  version: number,
  seq: number,
  prev: ShardPointer[] = [],
): ShardPointer[] {
  const byMonth = new Map<string, ChunkEntry[]>();
  for (const e of chunks) {
    const month = shardMonthForEntry(e);
    const list = byMonth.get(month);
    if (list) list.push(e);
    else byMonth.set(month, [e]);
  }
  const out: ShardPointer[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    const entries = (byMonth.get(month) ?? []).slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    let minKey = '';
    let maxKey = '';
    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = Number.NEGATIVE_INFINITY;
    for (const e of entries) {
      if (e.minKey && (minKey === '' || e.minKey < minKey)) minKey = e.minKey;
      if (e.maxKey && (maxKey === '' || e.maxKey > maxKey)) maxKey = e.maxKey;
      if (typeof e.tsMin === 'number' && e.tsMin < minTs) minTs = e.tsMin;
      if (typeof e.tsMax === 'number' && e.tsMax > maxTs) maxTs = e.tsMax;
    }
    const shard: ManifestShard = { version, month, chunks: entries, seq };
    out.push({
      name: month,
      file: shardFileForMonth(month),
      count: entries.length,
      minKey,
      maxKey,
      minTs: minTs === Number.POSITIVE_INFINITY ? 0 : minTs,
      maxTs: maxTs === Number.NEGATIVE_INFINITY ? 0 : maxTs,
      crc32c: shardCrc(shard),
    });
  }
  const fresh = new Set(out.map((p) => p.name));
  for (const p of prev) {
    if (typeof p?.name !== 'string' || fresh.has(p.name)) continue;
    fresh.add(p.name);
    out.push({ ...p });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// Save-path budget check: the pointers array must serialize within
// MAX_SHARD_POINTER_BYTES. Load never calls this, so old archives with a
// missing or oversized pointer list still parse and fall back to root.
export function assertShardPointersSize(pointers: ShardPointer[] | undefined): void {
  const bytes = Buffer.byteLength(JSON.stringify(pointers ?? []), 'utf8');
  if (bytes > MAX_SHARD_POINTER_BYTES) {
    throw new Error(`shard pointer list exceeds ${MAX_SHARD_POINTER_BYTES} bytes (got ${bytes})`);
  }
}

function shardEnvelopeBytes(s: ManifestShard): Buffer {
  return Buffer.from(JSON.stringify({
    version: s.version,
    month: s.month,
    chunks: s.chunks,
    seq: s.seq ?? 0,
  }), 'utf8');
}

export function shardCrc(s: ManifestShard): number {
  return crc32c(shardEnvelopeBytes(s));
}

function sparseEnvelopeBytes(s: SparseDisk): Buffer {
  return Buffer.from(JSON.stringify({
    version: s.version,
    seq: s.seq,
    total: s.total,
    quarantined: s.quarantined,
    entries: s.entries,
    cold: s.cold,
  }), 'utf8');
}

export function sparseCrc(s: SparseDisk): number {
  return crc32c(sparseEnvelopeBytes(s));
}

// Sparse rows persist sorted by minKey (unknown-range tail), mirroring the
// in-memory buildSparseIndex order so queries binary-search without parsing
// the full manifest.
export function buildSparseDiskEntries(chunks: ChunkEntry[]): SparseDiskEntry[] {
  const ranged: SparseDiskEntry[] = [];
  const unknown: SparseDiskEntry[] = [];
  for (const e of chunks) {
    if (e.quarantined) continue;
    const row: SparseDiskEntry = {
      file: e.file, minKey: e.minKey ?? '', maxKey: e.maxKey ?? '',
      seqMin: e.seqMin, month: shardMonthForEntry(e),
    };
    if (row.minKey && row.maxKey) ranged.push(row);
    else unknown.push(row);
  }
  ranged.sort((a, b) => (a.minKey < b.minKey ? -1 : a.minKey > b.minKey ? 1 : 0));
  return [...ranged, ...unknown];
}

export function buildSparseDisk(m: Manifest): SparseDisk {
  const quarantined = m.chunks.filter((e) => e.quarantined).length;
  const s: SparseDisk = {
    version: 1,
    seq: manifestSeq(m),
    total: m.chunks.length,
    quarantined,
    entries: buildSparseDiskEntries(m.chunks),
    cold: Array.isArray(m.cold) ? m.cold : [],
  };
  s.crc32c = sparseCrc(s);
  return s;
}

function parseSparseCopy(p: string): SparseDisk | null {
  try {
    const s = JSON.parse(readManifestText(p)) as SparseDisk;
    if (typeof s.seq !== 'number' || !Array.isArray(s.entries) || !Array.isArray(s.cold)) return null;
    if (typeof s.crc32c === 'number' && s.crc32c >>> 0 !== sparseCrc(s)) return null;
    return s;
  } catch {
    return null;
  }
}

function parseShardCopy(p: string): ManifestShard | null {
  try {
    const s = JSON.parse(readManifestText(p)) as ManifestShard;
    if (typeof s.month !== 'string' || !Array.isArray(s.chunks)) return null;
    if (typeof s.crc32c === 'number' && s.crc32c >>> 0 !== shardCrc(s)) return null;
    return s;
  } catch {
    return null;
  }
}

// Best crc-valid sparse copy wins (higher seq first); null when no sidecar yet.
export function loadSparseIndex(outDir: string): { sparse: SparseDisk; source: 'primary' | 'backup' } | null {
  const ranked = [
    { s: parseSparseCopy(join(outDir, 'sparse.json')), source: 'primary' },
    { s: parseSparseCopy(join(outDir, 'sparse.bak.json')), source: 'backup' },
  ] as const;
  let best: SparseDisk | null = null;
  let bestSource: 'primary' | 'backup' = 'primary';
  let bestSeq = -1;
  for (const { s, source } of ranked) {
    if (!s) continue;
    const seq = Number.isFinite(s.seq) && s.seq > 0 ? Math.floor(s.seq) : 0;
    if (seq > bestSeq) {
      best = s;
      bestSource = source;
      bestSeq = seq;
    }
  }
  return best ? { sparse: best, source: bestSource } : null;
}

export function loadShard(outDir: string, month: string): ManifestShard | null {
  return parseShardCopy(join(outDir, shardFileForMonth(month)));
}

// Shard months present on disk (no root parse); lets queries resolve the
// relevant sidecars from the sparse index alone.
export function listShardMonths(outDir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(outDir);
  } catch {
    return [];
  }
  return names
    .filter((f) => /^manifest-\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.slice('manifest-'.length, -'.json'.length))
    .sort();
}

// Load exactly the requested months; corrupt/missing months land in missing so
// the caller can fall back to the full root manifest.
export function loadChunksForMonths(outDir: string, months: string[]): {
  chunks: ChunkEntry[]; shardsLoaded: number; shardsMissing: string[]; seq: number;
} {
  const chunks: ChunkEntry[] = [];
  let shardsLoaded = 0;
  const shardsMissing: string[] = [];
  let seq = 0;
  for (const month of months) {
    const s = loadShard(outDir, month);
    if (!s) {
      shardsMissing.push(month);
      continue;
    }
    shardsLoaded++;
    if (typeof s.seq === 'number' && Number.isFinite(s.seq)) seq = Math.max(seq, Math.floor(s.seq));
    for (const e of s.chunks) chunks.push(e);
  }
  return { chunks, shardsLoaded, shardsMissing, seq };
}

function writeFileAtomicSync(dest: string, payload: string): void {
  const nonce = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const tmp = `${dest}.tmp.${process.pid}.${nonce}`;
  writeFileSync(tmp, payload);
  fsyncFile(tmp);
  renameSync(tmp, dest);
}

// Sidecars for a freshly stamped manifest: one shard file per month, stale
// months removed, plus the dual-copy persisted sparse index.
function saveShardSidecars(outDir: string, m: Manifest): void {
  const seq = manifestSeq(m);
  const byMonth = new Map<string, ChunkEntry[]>();
  for (const e of m.chunks) {
    const month = shardMonthForEntry(e);
    const list = byMonth.get(month);
    if (list) list.push(e);
    else byMonth.set(month, [e]);
  }
  const months = [...byMonth.keys()].sort();
  for (const month of months) {
    const entries = (byMonth.get(month) ?? []).slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const shard: ManifestShard = { version: m.version, month, chunks: entries, seq };
    shard.crc32c = shardCrc(shard);
    writeFileAtomicSync(join(outDir, shardFileForMonth(month)), `${JSON.stringify(shard, null, 1)}\n`);
  }
  for (const month of listShardMonths(outDir)) {
    if (!byMonth.has(month)) {
      try { unlinkSync(join(outDir, shardFileForMonth(month))); } catch { /* already gone */ }
    }
  }
  const sparse = buildSparseDisk(m);
  const payload = `${JSON.stringify(sparse, null, 1)}\n`;
  for (const name of ['sparse.json', 'sparse.bak.json']) {
    writeFileAtomicSync(join(outDir, name), payload);
  }
}

function fsyncFile(p: string): void {
  const fd = openSync(p, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDir(p: string): void {
  try {
    const fd = openSync(p, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* Windows: dir fsync unsupported, rename is enough */ }
}

export function scanChunk(full: string, name: string, dictDir?: string): ChunkEntry {
  const buf = readFileSync(full);
  const header = decodeHeader(buf);
  const body = buf.subarray(HEADER_SIZE, HEADER_SIZE + header.bodyLen);
  const crc = crc32c(body);
  if (crc !== header.crc32c) throw new Error(`crc32c mismatch in ${name}`);
  // Dict chunks resolve their trained dictionary; flagless (pre-dict) chunks decode inline.
  const dict = (header.flags & DICT_FLAG) !== 0 && dictDir ? loadDictFor(dictDir, header.dictId) ?? undefined : undefined;
  // Full decode for min/max keys + bloom; corrupt bodies surface here, not at find-time.
  const { rows } = decodeChunk(Buffer.from(buf), dict);
  const ids = rows.map((r) => r.id).sort();
  return {
    file: name,
    table: rows[0]?.table ?? name.split('-')[0],
    seqMin: Number(header.seqMin), seqMax: Number(header.seqMax),
    tsMin: Number(header.tsMin), tsMax: Number(header.tsMax),
    rows: header.rows, bytes: buf.length,
    sha256: sha256hex(buf), crc32c: header.crc32c,
    dictId: header.dictId, codec: header.codec,
    minKey: ids[0] ?? '', maxKey: ids[ids.length - 1] ?? '',
    bloom: buildBloom(ids),
  };
}

export function buildManifest(outDir: string): Manifest {
  const warm = join(outDir, 'warm');
  mkdirSync(warm, { recursive: true });
  const chunks: ChunkEntry[] = [];
  const names = readdirSync(warm).filter((f: string) => f.endsWith('.chk')).sort();
  for (const name of names) {
    try {
      chunks.push(scanChunk(join(warm, name), name, join(outDir, 'dicts')));
    } catch {
      // Corrupt chunk: keep a quarantined stub so history survives minus 1 chunk.
      const buf = readFileSync(join(warm, name));
      chunks.push({
        file: name, table: name.split('-')[0],
        seqMin: 0, seqMax: 0, tsMin: 0, tsMax: 0, rows: 0, bytes: buf.length,
        sha256: sha256hex(buf), crc32c: 0, dictId: 0, codec: 0,
        minKey: '', maxKey: '', bloom: '', quarantined: true,
      });
    }
  }
  const m: Manifest = { version: 1, createdAt: new Date().toISOString(), chunks, cold: [], shards: shardMonthsFor(chunks), seq: 0 };
  m.pointers = buildShardPointers(chunks, m.version, 0);
  m.crc32c = manifestCrc(m);
  return m;
}

// Deterministic filenames carry table+seq range; rebuild works even if both
// manifest copies are lost (bloom/minmax refill on next seal or lazy at find).
export function rebuildFromFilenames(outDir: string): Manifest {
  return buildManifest(outDir);
}

export function saveManifestAtomic(outDir: string, m: Manifest): void {
  mkdirSync(outDir, { recursive: true });
  stampEnvelope(m, prevValidSeq(outDir));
  const payload = `${JSON.stringify(m, null, 1)}\n`;
  for (const name of ['manifest.json', 'manifest.bak.json']) {
    const dest = join(outDir, name);
    const nonce = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    const tmp = `${dest}.tmp.${process.pid}.${nonce}`;
    writeFileSync(tmp, payload);
    fsyncFile(tmp);
    renameSync(tmp, dest);
  }
  // Shard + sparse sidecars carry the same seq; a torn sidecar falls back to
  // the root copies, so they never gate durability.
  try {
    saveShardSidecars(outDir, m);
  } catch { /* sidecars are a pure speedup: root copies already durable */ }
  fsyncDir(outDir);
}

export function loadManifest(outDir: string): { manifest: Manifest; source: 'primary' | 'backup' | 'rebuilt' } {
  const primary = parseManifestCopy(join(outDir, 'manifest.json'));
  const backup = parseManifestCopy(join(outDir, 'manifest.bak.json'));
  // Best crc-valid copy wins: higher seq first, primary breaks ties. A torn
  // primary no longer shadows a good backup.
  const ranked = [
    { m: primary, source: 'primary' },
    { m: backup, source: 'backup' },
  ] as const;
  let best: Manifest | null = null;
  let bestSource: 'primary' | 'backup' = 'primary';
  let bestSeq = -1;
  for (const { m, source } of ranked) {
    if (!m) continue;
    const seq = manifestSeq(m);
    if (seq > bestSeq) {
      best = m;
      bestSource = source;
      bestSeq = seq;
    }
  }
  if (best) {
    if (!Array.isArray(best.cold)) best.cold = [];
    return { manifest: best, source: bestSource };
  }
  if (!existsSync(join(outDir, 'warm'))) throw new Error(`no archive at ${outDir}`);
  // Rebuilt path owns cold[] preservation now: salvage the listing from either
  // torn copy before the rescan, so seal no longer needs its own reattach.
  const cold = salvageCold(outDir);
  const rebuilt = rebuildFromFilenames(outDir);
  if (cold !== undefined) rebuilt.cold = cold;
  saveManifestAtomic(outDir, rebuilt);
  return { manifest: rebuilt, source: 'rebuilt' };
}

// Append-only fast path for seal: merge caller-scanned entries into the best
// crc-valid manifest without a full warm rescan. Dedupe by filename; existing
// entries win so a retry never duplicates. Bumps seq+crc via the atomic save.
export function appendEntries(outDir: string, entries: ChunkEntry[]): Manifest {
  const { manifest } = loadManifest(outDir);
  const known = new Set(manifest.chunks.map((e) => e.file));
  for (const e of entries) {
    if (known.has(e.file)) continue;
    known.add(e.file);
    manifest.chunks.push({ ...e });
  }
  manifest.chunks.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  saveManifestAtomic(outDir, manifest);
  return manifest;
}
