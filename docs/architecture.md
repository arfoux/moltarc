# moltarc architecture

Extraction of the hot-warm-cold pipeline as documented in `README.md` and
`docs/decisions.md`. No new claims: every paragraph cites its source as
`file:line`. `src/` paths below are repeated from those sources, not
re-audited here.

## Pipeline

```text
[hot.db r/w SQLite] --seal--> [warm/*.zst 1-4MB immutable] --merge--> [cold/*.tar.zst] + manifest.json
```

(`README.md:9`). CLI over archive dirs: `seal | ship | find | status | gc | merge |
forget | coldg` (`README.md:58`, `bin/moltarc.ts:35-48`).

## Hot: boring SQLite or JSONL WAL

- Hot input auto-detects: `hot.db` SQLite (magic `SQLite format 3`, tables
  `tx`/`log` with `device_id,seq,ts,id,table,body` via `bun:sqlite`) or JSONL WAL
  export, one object per line (`README.md:34-35`).
- Per-device `sealed_upto_seq` watermark (`device_id -> max seq`) plus
  `device_id:seq` dedupe make re-seal idempotent (`README.md:36`).
- Rule: hot stays SQLite boring, no custom header (`README.md:42`).
- Rule: never delete unsealed/unacked data; `forget`/`gc` only drop relay-acked
  chunks (`README.md:48`, `docs/decisions.md:64`).

## Warm: sealed columnar chunks

- Seal packs per-table batches to `TARGET_BYTES` 2MB; flush gates on target,
  hard tail rule at `MAX_BYTES` 4MB, `MIN_BYTES` 1MB floor
  (`docs/decisions.md:8`; packing loop `src/seal.ts:285-336`).
- Chunks are content-addressed and immutable once flushed; seal never deletes
  input, ship never deletes source, CAS puts never rewrite identical bytes
  (`docs/decisions.md:64`).
- Warm chunk header is 64B: `magic UMK1 | ver | codec | table | seq_min/max |
  ts_min/max | rows | crc32c | dict_id` (`README.md:42`).
- Codec: zstd (Node 22 built-in) with deflate fallback; `codec` byte keeps chunks
  self-describing, dict inline in the frame
  (`README.md:32-33`; `src/chunk.ts:118-129` decode `src/chunk.ts:145-151`,
  `docs/decisions.md:15`).
- zstd-only, no LZ4: one codec keeps `decodeHeader` + `DECOMPRESS_MAX_BYTES` cap
  a single audit surface; measured 34.5x repetitive text / 10.2x mixed come from
  zstd alone (`docs/decisions.md:15-16`).
- Per-table 32KB zstd dicts, trained only when the sample compresses 4x+
  (`README.md:57`); gate is `bodies >= 100`, `sampleRatio >= 4`, non-blob table,
  dict capped at `DICT_MAX_BYTES` 32KB from first 10k rows
  (`docs/decisions.md:22`).
- Measured warm sizes: repetitive tx text 1.64MB -> 48.6KB (**34.5x**), mixed
  text 2.40MB -> 241.0KB (**10.2x**), photo sidecar excluded as incompressible
  (`README.md:75-81`); dict saves ~1.8% on repetitive text at 16KB chunks and
  ~0% at 2MB production chunks (`README.md:100-104`).
- Components: `src/seal.ts` hot WAL -> warm columnar chunks (delta/RLE/dict +
  zstd) (`README.md:52`); `src/dict.ts` per-table dicts (`README.md:57`).

## Manifest: dual-copy index

- `saveManifestAtomic` writes identical payload to `manifest.json` +
  `manifest.bak.json` via tmp+fsync+rename, then best-effort sidecars; load picks
  best crc-valid seq, primary breaks ties
  (`docs/decisions.md:57`; `src/manifest.ts:450-467` save,
  `src/manifest.ts:469-493` load).
- Sparse/shard sidecars carry the same seq and fall back to root on skew
  (`docs/decisions.md:57`; `src/find.ts:250-262`, `src/manifest.ts:285-295`).
- Each entry carries min/max range + bloom: legacy entries use `BLOOM_BITS =
  2048`, 3 hashes; newer chunks scale to >= rows x 10 bits; reader mods by actual
  stored length
  (`docs/decisions.md:29`; `src/manifest.ts:8`, `src/manifest.ts:81-99`,
  `src/find.ts:155-161`, `src/find.ts:169-173`).
- Kill mid-batch loses only the unflushed tail: watermark advances per flushed
  chunk and each save bumps the envelope seq
  (`docs/decisions.md:58`; `src/seal.ts:1-3`).
- Rule: manifest atomic (tmp + fsync + rename), dual copy + rebuild from
  deterministic filenames (`README.md:43`).
- Component: `src/manifest.ts` atomic manifest, min/max + bloom, rebuild scan
  (`README.md:53`).

## Ship: delta by hash, text-first lanes

- `laneOf` maps blob/photo/image/thumb tables to lane 1, everything else lane 0;
  `planShipment` skips lane 1 unless `includeBlobs`, sorts lane then seq
  (`docs/decisions.md:43`; `src/ship.ts:32-39`, `src/ship.ts:41-52`).
- Text-first because photo bytes compress ~1.05x raw while text hits 26.8x
  beside the photos, so blobs would dominate bytes for zero ratio
  (`docs/decisions.md:44`; photo numbers `README.md:87-94`).
- Delta economics come from immutable chunks: the relay index hash hit stays
  valid forever, giving 1791B delta vs 211716B full (0.008)
  (`docs/decisions.md:65`; `src/ship.ts:47`).
- Rule: text vs blob split — archive ships text+hash+thumb, full photos
  lazy/on-demand (`README.md:45`).
- Component: `src/ship.ts` delta by hash, chunked resume, text-first lanes
  (`README.md:55`).

## Find: warm-default, single-chunk fetch

- `findTrx` searches warm only and throws when absent; cold needs `findCold`,
  which narrows by warm index then warns per scan
  (`docs/decisions.md:50`; `src/find.ts:265-306`, `src/find.ts:308-354`,
  warn at `src/find.ts:352-354`).
- Warm find is 7.62ms median, 1 fetch / 2 pruned; the min/max + bloom chain is
  what keeps it there
  (`docs/decisions.md:30-51`; `src/find.ts:185-225`).
- Cold scan is O(segments) tar decode over already-zstd members, slower by
  construction (`docs/decisions.md:51`; `src/cold.ts:1-2`).
- CLI: `moltarc find <trx-id>` fetches 1 chunk via manifest
  (`README.md:17`; `bin/moltarc.ts:38`).
- Component: `src/find.ts` prune + bloom + single-chunk fetch + sparse index
  (`README.md:56`).

## Cold: tar merge, prune, quarantine

- `src/cold.ts` warm-to-cold tar merge plus prune sweep (repack without dead
  members, manifest rewrite) (`README.md:54`).
- Cold prune keeps the manifest rewrite atomic dual-copy
  (`docs/decisions.md:64`; `src/cold.ts:253-272`).
- Corrupt segments quarantine-never-delete-blind; verify quarantines exactly one
  chunk and repairs by hash from relay
  (`docs/decisions.md:64`; `src/cold.ts:331`, `src/verify.ts:80-93`,
  `src/verify.ts:116-123`).
- Rule: per-chunk `crc32c + sha256`; corrupt chunk quarantines 1/150 of history,
  never total-loss (`README.md:46`).
- Sweep is dry-run by default and only deletes relay-acked orphans
  (`docs/decisions.md:64`; `src/gc.ts:1-4`, `src/gc.ts:52-63`).

## Disk-safety reserve

- `RESERVE_BYTES = 50MB`; `checkReserve` throws before any write on
  seal/merge/sweep-apply; sweep-delete-only never checks
  (`docs/decisions.md:36`; `src/gc.ts:24`, `src/gc.ts:36-44`,
  `src/seal.ts:230`, `src/cold.ts:303`, `src/gc.ts:11-14`).
- The reserve guarantees tmp+fsync+rename never starts without room for the
  largest expected write (one 4MB chunk + manifest copies + tar window)
  (`docs/decisions.md:37`).

## Source map

| Concern | Source of truth |
|---|---|
| Design rationale for all of the above | `docs/decisions.md:1-67` |
| Pipeline, CLI, rules, layout, measured SLA | `README.md:6-107` |
| Benchmark method behind the ratios | `docs/bench.md` |
| Back-compat surface | `docs/compat.md` |
