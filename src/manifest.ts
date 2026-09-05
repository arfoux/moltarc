// molt manifest — atomic tmp+fsync+rename, dual copy, min/max+bloom, rebuild-from-filenames.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { crc32c, decodeChunk, decodeHeader, fnv1a32, HEADER_SIZE, sha256hex } from './chunk.js';

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

export interface Manifest {
  version: number;
  createdAt: string;
  chunks: ChunkEntry[];
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

export function scanChunk(full: string, name: string): ChunkEntry {
  const buf = readFileSync(full);
  const header = decodeHeader(buf);
  const body = buf.subarray(HEADER_SIZE, HEADER_SIZE + header.bodyLen);
  const crc = crc32c(body);
  if (crc !== header.crc32c) throw new Error(`crc32c mismatch in ${name}`);
  // Full decode for min/max keys + bloom; corrupt bodies surface here, not at find-time.
  const { rows } = decodeChunk(Buffer.from(buf));
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
      chunks.push(scanChunk(join(warm, name), name));
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
  return { version: 1, createdAt: new Date().toISOString(), chunks };
}

// Deterministic filenames carry table+seq range; rebuild works even if both
// manifest copies are lost (bloom/minmax refill on next seal or lazy at find).
export function rebuildFromFilenames(outDir: string): Manifest {
  return buildManifest(outDir);
}

export function saveManifestAtomic(outDir: string, m: Manifest): void {
  mkdirSync(outDir, { recursive: true });
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
  const copies = [
    { name: 'manifest.json', source: 'primary' },
    { name: 'manifest.bak.json', source: 'backup' },
  ] as const;
  for (const { name, source } of copies) {
    try {
      const m = JSON.parse(readFileSync(join(outDir, name), 'utf8')) as Manifest;
      if (Array.isArray(m.chunks)) return { manifest: m, source };
    } catch { /* fall through to next copy */ }
  }
  if (!existsSync(join(outDir, 'warm'))) throw new Error(`no archive at ${outDir}`);
  const rebuilt = rebuildFromFilenames(outDir);
  saveManifestAtomic(outDir, rebuilt);
  return { manifest: rebuilt, source: 'rebuilt' };
}
