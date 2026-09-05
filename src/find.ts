// moltarc find — prune by min/max, bloom check, single-chunk fetch+verify, sparse index.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { decodeChunk, decodeHeader, DICT_FLAG } from './chunk.js';
import type { HotRow } from './chunk.js';
import { loadDictFor } from './dict.js';
import { bloomCheck, loadManifest } from './manifest.js';
import type { ChunkEntry } from './manifest.js';

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

function inRange(e: ChunkEntry, trxId: string): boolean {
  if (!e.minKey || !e.maxKey) return true; // unknown range: cannot prune
  return e.minKey <= trxId && trxId <= e.maxKey;
}

export function candidates(entries: ChunkEntry[], trxId: string): { hit: ChunkEntry[]; pruned: number } {
  const hit: ChunkEntry[] = [];
  let pruned = 0;
  for (const e of entries) {
    if (e.quarantined || !inRange(e, trxId)) { pruned++; continue; }
    if (!bloomCheck(e.bloom, trxId)) { pruned++; continue; }
    hit.push(e);
  }
  hit.sort((a, b) => a.seqMin - b.seqMin);
  return { hit, pruned };
}

export function findTrx(opts: FindOpts): FindResult {
  const { manifest } = loadManifest(opts.outDir);
  const dir = opts.chunkDir ?? join(opts.outDir, 'warm');
  const dictDir = join(dir, '..', 'dicts');
  const { hit, pruned } = candidates(manifest.chunks, opts.trxId);
  let fetched = 0;
  for (const e of hit) {
    const full = join(dir, e.file);
    if (!existsSync(full)) continue;
    // Single-chunk fetch: read + verify (crc inside decodeChunk) + decode.
    const buf = readFileSync(full);
    const dict = (decodeHeader(buf).flags & DICT_FLAG) !== 0 ? loadDictFor(dictDir, e.dictId) ?? undefined : undefined;
    const { rows } = decodeChunk(buf, dict);
    fetched++;
    const row = rows.find((r) => r.id === opts.trxId);
    if (row) return { row, chunk: e.file, chunksFetched: fetched, chunksPruned: pruned };
  }
  throw new Error(`trx ${opts.trxId} not found (${fetched} chunk(s) fetched, ${pruned} pruned)`);
}
