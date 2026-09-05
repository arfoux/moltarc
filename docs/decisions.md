# molt decisions — why each load-bearing choice

Date: 2026-09-06. Each entry grounded in code + `bench/measured.json` / `docs/bench.md`.
Reversed-consequence states what breaks, not opinion.

## 1. Chunk 1–4MB bounds, ~2MB target

- Decision: seal packs per-table batches to `TARGET_BYTES` (2MB); flush gates on target, hard tail rule at `MAX_BYTES` (4MB); `MIN_BYTES` (1MB) documents the small-chunk floor. `src/seal.ts:15-17`, packing/probe loop `src/seal.ts:285-336`.
- Context: mixed corpus (6000 rows, seed 7) seals 2.52MB input into 3 warm chunks, 246774B (`bench/measured.json` perf; `docs/bench.md` seal 8.3MB/s in 290ms). ~0.8MB compressed per chunk keeps find to 1 chunk fetch (`findFetched: 1`).
- Alternatives rejected: 64KB chunks (manifest with thousands of entries, shard/sparse index bloat, ship delta fans out); 64MB chunks (find pays full read+crc+decode per lookup; a corrupt chunk quarantines 64MB instead of ~1MB, cf. `src/verify.ts:81-92` quarantine-one design).
- If reversed: tiny chunks → manifest/shard/sparse growth + N-fetch finds; huge chunks → 7.62ms median find (`bench/measured.json`) regresses linearly with chunk bytes, quarantine blast radius grows with chunk size.

## 2. zstd only, no LZ4

- Decision: `compressFrame` tries zstd, then zstd+dict, falls back to deflate (`src/chunk.ts:118-129`); decode accepts zstd/deflate/none (`src/chunk.ts:145-151`). No LZ4 codec exists.
- Context: measured ratios come from zstd alone — 34.5x repetitive text, 10.2x mixed (`bench/measured.json` mixed; `docs/bench.md`), 1.05x on raw jpeg proving incompressible passthrough. One codec keeps `decodeHeader` + `DECOMPRESS_MAX_BYTES` cap (`src/chunk.ts:133`) a single audit surface.
- Alternatives rejected: LZ4 as default (faster decode, ~2-3x worse ratio on text — would forfeit the 34.5x/10.2x warm-size wins that make ship deltas 1791B viable); dual zstd+LZ4 codecs (second decode path + per-chunk codec negotiation for no measured need).
- If reversed: LZ4 default inflates every warm chunk toward raw size; dual-codec doubles decode-path bug surface and breaks the N-2 compat error contract (`src/chunk.ts:151`).

## 3. Dict gate: train only when sample ≥4x, ≥100 rows, non-blob, 32KB cap

- Decision: `trainTableDict` returns null unless `bodies ≥ 100`, `sampleRatio ≥ 4`, table not matching `BLOB_TABLE_RE`; dict capped at `DICT_MAX_BYTES` 32KB from first 10k rows (`src/dict.ts:10-11,44-62`; gate comment `src/dict.ts:22-23`).
- Context: dict bench (12000 rows, seed 7) saves 1840B / 1.7% (`bench/measured.json` dict) — small because zstd already hits 30.5x plain. Photo bench shows jpeg at 1.05x raw, so blob tables would train a useless dict; hence the blob exclusion (`src/dict.ts:35-42`).
- Alternatives rejected: always-train (a dict file + `DICT_FLAG` lookup per chunk for ~0% on blobs/jpegs); higher gate (8x — kills the measured 1.7% on real repetitive text); bigger dict (diminishing returns past ranked-line working set, more relay bytes via copy-if-missing `src/ship.ts:158-161`).
- If reversed: gate removed → dict files on incompressible tables, wasted relay copies + decode lookups; gate raised → the only measured dict win disappears.

## 4. Bloom 2048 bits, k=3, scaled reads

- Decision: legacy entries use `BLOOM_BITS = 2048` (`src/manifest.ts:8`), 3 hashes (`src/manifest.ts:81-99`); `bloomBitsForRows` scales newer chunks to ≥ rows×10 bits (`src/find.ts:155-161`); reader mods by actual stored length (`src/find.ts:169-173`).
- Context: perf find prunes 2 chunks while fetching 1 (`bench/measured.json` `findPruned: 2, findFetched: 1`) — min/max range + bloom chain (`src/find.ts:185-225`) is what keeps the 7.62ms median.
- Alternatives rejected: no bloom (every in-range chunk decodes — fetched count rises with chunk count); 256-bit bloom (fp rate forces decodes of non-matching chunks); fixed-size-only reader (breaks scaled chunks or wastes bits on small ones).
- If reversed: bloom removed/shrunk → `fetched` climbs, find latency follows decode cost; fixed-2048 reader → scaled entries mis-decode (false negatives = lost rows).

## 5. 50MB free-space reserve, fail-closed

- Decision: `RESERVE_BYTES = 50MB` (`src/gc.ts:24`); `checkReserve` throws before any write on seal/merge/sweep-apply (`src/gc.ts:36-44`, `src/seal.ts:230`, `src/cold.ts:303`); sweep-delete-only never checks (`src/gc.ts:11-14`).
- Context: a torn chunk/watermark/manifest copy is the failure the dual-copy design exists to survive (`src/manifest.ts:450-467`); reserve guarantees the tmp+fsync+rename never starts without room for the largest expected write (one 4MB chunk + manifest copies + tar window).
- Alternatives rejected: no reserve (half-written chunk + torn manifest under disk pressure — exactly the corruption quarantine/repair exists for); tiny reserve (1MB — a single MAX chunk exceeds it); reserve on deletes too (deletes free space; gating them strands orphans).
- If reversed: seal under pressure half-writes warm chunks and manifest copies, forcing quarantine (`src/verify.ts:81-92`) and relay repair on what should have been a clean refusal.

## 6. Text-first ship lanes, blobs opt-in

- Decision: `laneOf` maps blob/photo/image/thumb tables to lane 1, everything else lane 0 (`src/ship.ts:32-39`); `planShipment` skips lane-1 unless `includeBlobs`, sorts lane then seq (`src/ship.ts:41-52`). Measured: full ship 211716B in 2 chunks default lanes; blob chunk ships only with flag (`docs/bench.md`, `bench/measured.json` perf).
- Context: photo bench — 590KB jpeg compresses to only 1.41x/1.05x while 600 text rows hit 26.8x (`bench/measured.json` photo). Blobs dominate bytes, add zero ratio.
- Alternatives rejected: single FIFO lane (a 3.2MB blob sidecar, cf. bench mixed `blobBytes: 3387392`, blocks text deltas behind incompressible bytes); blobs-always (every `ship` pays photo cost; low-bandwidth relays stall).
- If reversed: full ship carries incompressible blob chunks by default; the 0.008 delta-vs-full ratio (`bench/measured.json`) regresses whenever a blob chunk is in the missing set.

## 7. Warm-only `findTrx` default, `findCold` opt-in and loud

- Decision: `findTrx` searches warm only and throws when absent (`src/find.ts:265-306`); cold needs `findCold`, which narrows by warm index then warns per scan (`src/find.ts:308-354`, warn at `src/find.ts:352-354`).
- Context: warm find is 7.62ms median, 1 fetch / 2 pruned (`bench/measured.json`); cold scan is O(segments) tar decode over already-zstd members (`src/cold.ts:1-2`) — orders of magnitude slower by construction.
- Alternatives rejected: unified find (every miss pays a tar scan; typo'd ids cost seconds); silent cold fallback (operators can't tell a 7ms hit from a multi-second scan in logs).
- If reversed: default find latency becomes segment-count-dependent; fully-pruned keys still pay directory-list + open costs instead of failing fast at the index.

## 8. Dual-copy manifest (+ sparse/shard), best-seq-wins load

- Decision: `saveManifestAtomic` writes identical payload to `manifest.json` + `manifest.bak.json` via tmp+fsync+rename, then best-effort sidecars (`src/manifest.ts:450-467`); `loadManifest` picks best crc-valid seq, primary breaks ties (`src/manifest.ts:469-493`); sparse/shard sidecars carry the same seq and fall back to root on skew (`src/find.ts:250-262`, `src/manifest.ts:285-295`).
- Context: kill mid-batch loses only the unflushed tail because the watermark advances per flushed chunk (`src/seal.ts:1-3`) and each save bumps the envelope seq — a torn primary never shadows a good backup.
- Alternatives rejected: single manifest (one torn rename = total index loss; `verify.ts:64-78` strict load would throw with no fallback); last-write-wins without seq (a stale primary can shadow a newer backup after a crash); WAL/journal instead (second recovery protocol for a JSON file rewritten per seal).
- If reversed: single copy → any torn write needs `rebuildFromFilenames` (blooms/minmax lost, full rescan); seq-less load → crash ordering can resurrect stale chunk sets.

## 9. No-rewrite rules: immutable chunks, seal never deletes, repair-by-hash

- Decision: chunks content-addressed and immutable once flushed (`src/seal.ts:318-329` oversize-still-ships comment; `src/chunk.ts` header); seal never deletes input (`src/seal.ts:2`); ship never deletes source (`src/ship.ts:3`); CAS puts never rewrite identical bytes (`src/cas.ts:38-41`); corrupt segments quarantine-never-delete-blind (`src/cold.ts:331`); verify quarantines exactly one chunk (`src/verify.ts:80-93`) and repairs by hash from relay (`src/verify.ts:116-123`); sweep is dry-run by default and only deletes relay-acked orphans (`src/gc.ts:1-4,52-63`); cold prune keeps manifest rewrite atomic dual-copy (`src/cold.ts:253-272`).
- Context: delta ship is 1791B vs 211716B full (0.008, `bench/measured.json`) precisely because old chunks never change — the relay index hash hit (`src/ship.ts:47`) stays valid forever.
- Alternatives rejected: in-place chunk mutation/compaction (invalidates relay hashes, forces re-ship of full bytes, breaks content addressing); eager delete-on-seal/GC (a kill between delete and manifest save loses data the relay never acked).
- If reversed: any rewrite breaks hash-stable deltas (every ship becomes full); any eager delete turns a mid-batch kill into permanent loss instead of an orphan sweep or quarantine+repair.
