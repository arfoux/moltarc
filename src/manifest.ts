// moltarc manifest — atomic tmp+fsync+rename, dual copy, min/max+bloom, rebuild-from-filenames.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
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

export interface Manifest {
  version: number;
  createdAt: string;
  chunks: ChunkEntry[];
  cold?: ColdSegment[];
  // Generation envelope: seq bumps on every atomic save, crc32c self-validates
  // the envelope so load can pick the best crc-valid copy. Both optional so
  // pre-envelope (v0/v1) archives still load as seq 0.
  seq?: number;
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
// save and load agree regardless of key insertion order on disk.
function envelopeBytes(m: Manifest): Buffer {
  return Buffer.from(JSON.stringify({
    version: m.version,
    createdAt: m.createdAt,
    chunks: m.chunks,
    cold: m.cold ?? [],
    seq: m.seq ?? 0,
  }), 'utf8');
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
  m.crc32c = manifestCrc(m);
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
  const m: Manifest = { version: 1, createdAt: new Date().toISOString(), chunks, cold: [], seq: 0 };
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
    const tmp = `${dest}.tmp.${process.pid}`;
    writeFileSync(tmp, payload);
    fsyncFile(tmp);
    renameSync(tmp, dest);
  }
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
