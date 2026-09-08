// moltarc timetravel — read-only state as-of (seq | ts).
// Fold order is seqMin ascending; latest row per id with seq/ts <= target wins.
// O(k) achieved via range prune: only chunks with seqMin/tsMin <= target are
// decoded; future chunks (min > target) are pruned without I/O. Bloom is not
// applicable here — timetravel filters by seq/ts, not id — so range prune is
// the sole pre-decode filter (mirrors candidates() tail-prune but keyed on
// seq/ts). Kept chunks are still decoded and row-filtered individually.
// Read-only: loadManifest + readFileSync + decodeChunk (crc proof inside).
//
// Damage contract (callers read this before touching proof):
//   FAIL-CLOSED-ON-CORRUPT — a kept chunk whose bytes fail decode (crc
//   mismatch, truncated body, bad frame) THROWS with the chunk filename in
//   the message. queryAsOf never skips a corrupt chunk and never returns a
//   partial fold over one: refusing beats guessing.
//   INCOMPLETE-ON-MISSING — a kept chunk whose file is absent from the warm
//   dir is skipped and counted in proof.skippedMissing; the returned rows
//   are a PARTIAL fold (ids from the missing chunk are stale or absent).
//   The skip is loud (console.warn naming the count) AND machine-visible
//   (proof.skippedMissing), but nothing throws — so every caller MUST check
//   proof.skippedMissing, or call assertTimeTravelComplete, before treating
//   rows as authoritative.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { decodeChunk, decodeHeader, DICT_FLAG, type HotRow } from './chunk.js';
import { loadDictFor } from './dict.js';
import { loadManifest } from './manifest.js';

export interface TimeTravelOpts {
  outDir: string;
  seq?: number;
  ts?: number;
  chunkDir?: string;
  /** windowed fold: only rows with ts >= target-windowMs (ts mode) take part.
   * Unwindowed (default) folds all history. windowed results carry only ids
   * seen inside the window — recent state, not full history. */
  windowMs?: number;
  /** windowed fold for seq mode: only rows with seq > target-windowSeq. */
  windowSeq?: number;
}

export interface TimeTravelProof {
  chunksConsulted: string[];
  chunksPruned: number;
  /** Kept-but-absent warm files skipped by this fold. >0 means rows are a
   * PARTIAL fold (incomplete-on-missing): warn-level loud plus this counter,
   * but no throw — the caller MUST branch on it (or run the result through
   * assertTimeTravelComplete) before treating rows as complete. Corrupt
   * bytes are the opposite case: they throw (fail-closed), never land here. */
  skippedMissing: number;
  manifestSource: string;
  windowed: boolean;
}

export interface TimeTravelResult {
  rows: HotRow[];
  proof: TimeTravelProof;
}
/**
 * Damage contract: FAIL-CLOSED-ON-CORRUPT (damaged chunk bytes throw, with
 * the filename in the message) plus INCOMPLETE-ON-MISSING (absent chunk
 * files are skipped, counted in proof.skippedMissing, rows are partial).
 * A skippedMissing > 0 result warns AND exposes the count, but does not
 * throw — check proof.skippedMissing (or assertTimeTravelComplete) before
 * treating rows as authoritative.
 */
export function queryAsOf(opts: TimeTravelOpts): TimeTravelResult {
  const hasSeq = typeof opts.seq === 'number';
  const hasTs = typeof opts.ts === 'number';
  if (hasSeq === hasTs) throw new Error('queryAsOf: exactly one of seq|ts is required');
  const targetSeq = hasSeq ? Math.floor(opts.seq as number) : null;
  const targetTs = hasTs ? (opts.ts as number) : null;
  if (targetSeq !== null && !(targetSeq >= 0)) throw new Error('queryAsOf: seq must be >= 0');
  if (opts.windowMs !== undefined && !(opts.windowMs >= 0)) throw new Error('queryAsOf: windowMs must be >= 0');
  if (opts.windowSeq !== undefined && !(opts.windowSeq >= 0)) throw new Error('queryAsOf: windowSeq must be >= 0');
  if (opts.windowMs !== undefined && !hasTs) throw new Error('queryAsOf: windowMs needs ts mode');
  if (opts.windowSeq !== undefined && !hasSeq) throw new Error('queryAsOf: windowSeq needs seq mode');
  const windowed = opts.windowMs !== undefined || opts.windowSeq !== undefined;
  const floorTs = hasTs && opts.windowMs !== undefined ? (targetTs as number) - (opts.windowMs as number) : null;
  const floorSeq = hasSeq && opts.windowSeq !== undefined ? (targetSeq as number) - (opts.windowSeq as number) : null;

  const dir = opts.chunkDir ?? join(opts.outDir, 'warm');
  const dictDir = join(dir, '..', 'dicts');
  const { manifest, source } = loadManifest(opts.outDir);

  // Range prune mirrors candidates() tail-prune, keyed on seq/ts not trx id.
  // O(k) via range prune: prune future chunks where target < min; bloom
  // pruning is skipped — timetravel has no id predicate, so bloomCheckScaled
  // is not applicable (kept for findTrx point queries only).
  const kept = [];
  let pruned = 0;
  for (const e of manifest.chunks) {
    if (e.quarantined) { pruned++; continue; }
    if (hasSeq) {
      // Prune only future chunks; seqMax < target still needed (all rows <= target)
      if ((targetSeq as number) < e.seqMin) { pruned++; continue; }
      // Window: chunks fully below the floor carry no in-window rows.
      if (floorSeq !== null && e.seqMax <= floorSeq) { pruned++; continue; }
      // bloom not applicable: no id filter, keep range-pruned set as-is
    } else {
      if ((targetTs as number) < e.tsMin) { pruned++; continue; }
      if (floorTs !== null && e.tsMax <= floorTs) { pruned++; continue; }
    }
    kept.push(e);
  }
  if (kept.length > 1000) console.warn(`timetravel: ${kept.length} chunks kept exceeds 1000, query may be slow (target ${hasSeq ? `seq=${targetSeq}` : `ts=${targetTs}`})`);
  kept.sort((a, b) => a.seqMin - b.seqMin);
  const consulted: string[] = [];
  let skippedMissing = 0;
  const state = new Map<string, HotRow>();
  for (const e of kept) {
    const full = join(dir, e.file);
    if (!existsSync(full)) { skippedMissing++; continue; }
    const buf = readFileSync(full);
    const dict = (decodeHeader(buf).flags & DICT_FLAG) !== 0 ? loadDictFor(dictDir, e.dictId) ?? undefined : undefined;
    // Fail-closed-on-corrupt: damaged bytes throw with the filename attached,
    // never silently skipped and never folded over. Missing files (above) are
    // the only skip path, and they stay counted + loud below.
    let rows: HotRow[];
    try {
      rows = decodeChunk(Buffer.from(buf), dict).rows; // crc proof; throws on mismatch
    } catch (err) {
      throw new Error(`timetravel: corrupt chunk ${e.file}: ${err instanceof Error ? err.message : String(err)} (fail-closed: refusing to return partial state)`);
    }
    consulted.push(e.file);
    for (const r of rows) {
      if (hasSeq ? r.seq > (targetSeq as number) : r.ts > (targetTs as number)) continue;
      if (floorSeq !== null && r.seq <= floorSeq) continue;
      if (floorTs !== null && r.ts <= floorTs) continue;
      const cur = state.get(r.id);
      if (!cur || r.seq > cur.seq || (r.seq === cur.seq && r.ts > cur.ts)) state.set(r.id, r);
    }
  }
  const rows = [...state.values()].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (skippedMissing > 0) console.warn(`timetravel: ${skippedMissing} chunk(s) missing, result incomplete — caller must check proof.skippedMissing`);
  return { rows, proof: { chunksConsulted: consulted, chunksPruned: pruned, skippedMissing, manifestSource: source, windowed } };
}

/**
 * Forcing function for the incomplete-on-missing half of the contract:
 * throws when res.proof.skippedMissing > 0, no-op otherwise. Call it before
 * treating queryAsOf rows as authoritative if your path cannot tolerate a
 * partial fold. (Corrupt chunks need no check here — they already threw
 * inside queryAsOf, fail-closed.)
 */
export function assertTimeTravelComplete(res: TimeTravelResult): void {
  if (res.proof.skippedMissing > 0)
    throw new Error(`timetravel: ${res.proof.skippedMissing} chunk(s) missing, result incomplete — caller must check proof.skippedMissing`);
}
