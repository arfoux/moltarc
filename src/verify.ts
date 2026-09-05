// molt verify — hash verify, quarantine 1 bad chunk without total loss, repair-by-hash.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { crc32c, decodeHeader, HEADER_SIZE, sha256hex } from './chunk.js';
import { loadManifest, saveManifestAtomic } from './manifest.js';

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

// Quarantine exactly the bad chunk; every other chunk stays readable.
export function quarantine(outDir: string, file: string): void {
  const warm = join(outDir, 'warm');
  const qdir = join(outDir, 'quarantine');
  mkdirSync(qdir, { recursive: true });
  const src = join(warm, file);
  if (existsSync(src)) renameSync(src, join(qdir, file));
  const { manifest } = loadManifest(outDir);
  const entry = manifest.chunks.find((e) => e.file === file);
  if (entry) {
    entry.quarantined = true;
    saveManifestAtomic(outDir, manifest);
  }
}

// Repair by content hash: relay holds the good bytes under the same sha256.
export function repairByHash(outDir: string, relayDir: string, file: string): void {
  const { manifest } = loadManifest(outDir);
  const entry = manifest.chunks.find((e) => e.file === file);
  if (!entry) throw new Error(`unknown chunk ${file}`);
  const relayFile = join(relayDir, 'chunks', file);
  if (!existsSync(relayFile)) throw new Error(`relay has no copy of ${file}`);
  const good = readFileSync(relayFile);
  if (sha256hex(good) !== entry.sha256) throw new Error('relay copy hash differs from manifest');
  const dest = join(outDir, 'warm', file);
  writeFileSync(dest, good);
  const check = verifyChunk(dest);
  if (!check.ok) throw new Error(`repaired chunk still bad: ${check.error}`);
  delete entry.quarantined;
  // A quarantined stub has no bloom/minmax; caller re-seals or rebuilds manifest.
  saveManifestAtomic(outDir, manifest);
}
