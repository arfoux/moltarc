// Per-table zstd dictionaries: trained from the first 10k rows when repetitive,
// stored content-hashed in <outDir>/dicts/, referenced by header dict_id.
// Chunks without the uses-dict flag (all pre-v0.4 chunks) decode inline.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { zstdCompressSync } from 'zlib';
import { fnv1a32, DICT_FLAG } from './chunk.js';

export { DICT_FLAG };
export const DICT_MAX_BYTES = 32 * 1024;
export const DICT_TRAIN_ROWS = 10_000;

export interface TrainedDict {
  dict: Buffer;
  dictId: number;
}

function hashBytes(b: Buffer): number {
  return fnv1a32(b.toString('latin1'));
}

// Repetition gate: the sample must compress >= 4x (substring repetition,
// not just whole-line duplicates) before a dictionary earns its keep.
export function sampleRatio(bodies: string[]): number {
  const sample = bodies.slice(0, Math.min(bodies.length, 200)).join('\n');
  if (sample.length === 0) return 1;
  const raw = Buffer.byteLength(sample);
  try {
    return raw / zstdCompressSync(Buffer.from(sample)).length;
  } catch {
    return 1;
  }
}

export function trainTableDict(bodies: string[]): TrainedDict | null {
  if (bodies.length < 100) return null;
  if (sampleRatio(bodies) < 4) return null;
  const sample = bodies.slice(0, DICT_TRAIN_ROWS);
  const freq = new Map<string, number>();
  for (const b of sample) freq.set(b, (freq.get(b) ?? 0) + 1);
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  const parts: Buffer[] = [];
  let size = 0;
  for (const s of ranked) {
    const b = Buffer.from(`${s}\n`, 'utf8');
    if (size + b.length > DICT_MAX_BYTES) break;
    parts.push(b);
    size += b.length;
  }
  const dict = Buffer.concat(parts);
  return { dict, dictId: hashBytes(dict) };
}

export function dictHex(dictId: number): string {
  return (dictId >>> 0).toString(16).padStart(8, '0');
}

export function dictFile(dictDir: string, dictId: number): string {
  return join(dictDir, `dict-${dictHex(dictId)}.dict`);
}

export function loadDictFor(dictDir: string, dictId: number): Buffer | null {
  const p = dictFile(dictDir, dictId);
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

export function saveDictAtomic(dictDir: string, dict: Buffer, dictId: number): string {
  mkdirSync(dictDir, { recursive: true });
  const dest = dictFile(dictDir, dictId);
  if (existsSync(dest)) return dest;
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, dict);
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, dest);
  return dest;
}
