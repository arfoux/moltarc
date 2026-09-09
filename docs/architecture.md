# moltarc architecture

Hot-warm-cold pipeline plus the sync/history/upgrade paths around it. Every
paragraph cites its source as `file` (+ line where stable). `src/` behavior
below is re-audited for this page; rationale lives in `docs/decisions.md`.

## Pipeline

```text
[hot.db r/w SQLite] --seal--> [warm/*.chk 1-4MB immutable] --merge--> [cold/*.tar] + manifest.json
```

CLI over archive dirs — 15 subcommands, full reference in `docs/cli.md`,
shape in `bin/moltarc.ts:35-53`.

## Hot: boring SQLite or JSONL WAL

- Hot input auto-detects: `hot.db` SQLite (magic `SQLite format 3`, tables
  `tx`/`log` with `device_id,seq,ts,id,table,body` via `bun:sqlite`) or JSONL
  WAL export, one object per line (`src/seal.ts:95-124`).
- Per-device `sealed_upto_seq` watermark (`device_id -> max seq`) plus
  keep-last dedupe on (table, device, seq) make re-seal idempotent; a second
  concurrent seal fails loud on `seal.lock` (`src/seal.ts:1-3`, CLI
  `docs/cli.md` seal).
- Rule: hot stays SQLite boring, no custom header.
- Rule: never delete unsealed/unacked data; `forget`/`gc` only drop
  relay-acked chunks (`src/cold.ts:307-324`, `src/gc.ts:83-86`).

## Warm: sealed columnar chunks

- Seal packs per-table batches to `TARGET_BYTES` 2 MB; floor `MIN_BYTES`
  1 MB, ceiling `MAX_BYTES` 4 MB (`src/seal.ts:17-19`).
- Chunks are content-addressed and immutable once flushed; seal never deletes
  input, ship never deletes source, CAS puts never rewrite identical bytes
  (`docs/decisions.md`, `src/cas.ts:34-46`).
- Warm chunk header is 64 B: `magic UMK1 | ver | codec | table | seq_min/max
  | ts_min/max | rows | crc32c | dict_id` (`src/chunk.ts:72-116`).
- Codec: writers emit zstd only; readers decode `NONE`/`ZSTD`/`DEFLATE` and
  hard-error on unknown ids — the N-2 window pinned in `docs/compat.md`.
- Per-table 32 KB dicts train only on ≥100 bodies with ≥4x sample ratio and
  never on blob tables (`src/dict.ts:44-47`, `DICT_MAX_BYTES` 32 KB).
- Measured warm sizes: repetitive tx text 1.64 MB → 48.6 KB (**34.5x**),
  mixed text 2.40 MB → 241.0 KB (**10.2x**) (`README.md` Measured SLA);
  dict saves ~1.8 % at 16 KB chunks, ~0 % at 2 MB production chunks
  (`README.md` Dict SLA).
- Photo gate: base64 bodies decoding past 256 KB (`PHOTO_INLINE_LIMIT_BYTES`,
  `src/seal.ts:20-22`) land in `photo/<sha>.bin` + thumb companions while the
  chunk keeps a `photo:sha256:…` hash ref (`src/seal.ts:176-213`,
  `src/thumb.ts:147-159`). Full contract in `docs/contracts.md`.

## Manifest: dual-copy index

- `saveManifestAtomic` writes identical payload to `manifest.json` +
  `manifest.bak.json` via tmp + fsync + rename with a seq+crc envelope; load
  picks the best crc-valid copy, primary breaking ties (`src/manifest.ts`,
  `manifestCrc`, `stripBom`).
- Sparse/shard sidecars (`sparse.json`, `manifest-YYYY-MM.json`, ≤2048 B
  pointer budget) carry the same seq and fall back to root on skew
  (`src/manifest.ts:211-295`, `src/find.ts:245-295`).
- Each entry carries min/max range + bloom: legacy `BLOOM_BITS = 2048`
  (3 hashes), newer chunks scale to ≥ rows × 10 bits; oversize (>1 MB),
  short, or corrupt bitsets fail open to fetch (`src/manifest.ts:8`,
  `src/find.ts:157-195`).
- Kill mid-batch loses only the unflushed tail: watermark advances per
  flushed chunk and each save bumps the envelope seq (`src/seal.ts:1-3`).
- Seal scans only new chunks and merges via `appendEntries` when a manifest
  copy exists; full rebuild stays for first seal (`src/manifest.ts`,
  `src/seal.ts`).

## Ship: delta by hash, text-first lanes

- `laneOf` maps blob/photo/image/thumb tables to lane 1, everything
  else lane 0; `planShipment` skips lane 1 unless `includeBlobs` and sorts
  lane-then-seq (`src/ship.ts:36-60`).
- Text-first because photo bytes compress ~1.05x raw while text hits 26.8x
  beside the photos — blobs would dominate bytes for zero ratio
  (`README.md` Photo SLA).
- Delta economics come from immutable chunks: the relay index hash hit stays
  valid forever, giving 1791 B delta vs 211 716 B full (`docs/bench.md`,
  `src/ship.ts:63-67`).
- With `includeBlobs`, `photo/*.bin` sidecars ship in the same call (small
  copy-if-missing, large resumable) — a ticket never precedes its painting
  (`src/ship.ts:218-228`).

## Find: warm-default, single-chunk fetch

- `findTrx` searches warm only and throws when absent; cold needs `findCold`
  (`src/find.ts:321-370`).
- Shard/sparse jump → min/max prune → scaled-bloom prune → ~1 fetch per lookup; warm
  find is ~13.60 ms p50 over 6 probed ids × 20 iters (11 fetched / 8 pruned total;
  `docs/bench.md`, `src/find.ts:197-295`).
- Cold scan is O(segments) tar decode over already-zstd members — slower by
  construction (`src/cold.ts`, `src/find.ts:366-370`).
- Quarantined entries never return; compound `table:device:seq` ids match
  via `matchRowId` (`src/find.ts:316-319`).

## Verify and quarantine

- `verifyFull` walks every chunk (`crc32c + sha256` + manifest binding) and
  checks the per-table seq chain: hard breaks fatal, forward seq skips
  `GAP` warnings only (`src/verify.ts:319-343`).
- Corrupt chunks park in `quarantine/` with a manifest flag — exactly one chunk
  of history lost (1/150 in a 150-chunk archive — illustrative size), never the archive. `repairAll` refetches good bytes by
  manifest sha256 from the relay and refills crc/bloom/minmax from the
  fetched bytes (`src/verify.ts:92-148`).
- Manifest load for quarantine/repair is strict (primary, then backup, else
  throw) — a lost manifest shows, never silently heals
  (`src/verify.ts:75-91`).

## Cold: tar merge, prune, restore

- `mergeCold` packs warm chunks plus their dict members into `cold/seg-*.tar`
  (streamed through a 1 MB window, byte-identical output) and records the
  segment (`src/cold.ts:110-124`).
- `sweepCold` (dry-run default, `--apply` + 50 MB reserve check) repacks
  segments without dead members and rewrites the manifest dual-copy atomic;
  corrupt segments list loud and stay on disk (`src/cold.ts:368-453`).
- `forgetChunks` is atomic all-or-nothing over relay-acked names only
  (`src/cold.ts:307-324`); bytes free only after `gc --apply` + `coldg
  --apply`.
- `restore-from-cold` validates every tar member name before touching disk
  and rebuilds warm + manifest from cold alone (`bin/moltarc.ts:78-137`).

## P2P: websocket delta sync

- Peers exchange summaries (`hello`/`welcome`), pull want-by-sha, stream
  base64 blocks, and apply atomically + idempotently with journal resume
  (`src/p2p.ts:76-120`).
- Every frame is `HMAC-SHA256(json) + '.' + json`, verified on raw bytes
  before parse against every listed key; `MOLTARC_PSK` rotates as a
  comma-separated list, primary first. Unset means documented
  trusted-LAN-only fallback (`src/p2p.ts:32-66`).
- Serving is opt-in filtered: `allowPeers` holds `sha256(token)` strings,
  empty serves anyone; quarantined entries are never served
  (`src/p2p.ts:44-45`, `summaryOf`).

## Timetravel: as-of reads

- `queryAsOf({ outDir, seq } | { outDir, ts })` folds latest-row-per-id at
  the target with chunk proof (consulted/pruned/`skippedMissing`)
  (`src/timetravel.ts:66-104`).
- Fail-closed on corrupt bytes (throws with the filename), explicit-partial
  on missing files (warn + counter — callers must check before treating rows
  as authoritative). Windowed folds (`windowMs`/`windowSeq`) return recent
  state only (`examples/dashboard.ts`).

## Migrate: forward-only upgrade

- `planMigration` (dry-run report, no writes) + `migrate` (rescan warm into
  a fresh v1 manifest, backup to `manifest.pre-migrate.json` first, atomic
  swap). Chunk files never touched (`src/migrate.ts:1-14`,
  `CURRENT_MANIFEST_VERSION = 1`).
- Seven write paths call `assertMigrated()`/`requireMigrated()` so a new binary never rewrites
  an old manifest in place — the guard error means "run migrate once"
  (`src/migrate.ts`, `docs/cli.md` migrate).

## Disk-safety reserve

- `RESERVE_BYTES = 50 MB`; `checkReserve` throws before any write on
  seal/merge/sweep-apply; sweep-delete-only never checks (`src/gc.ts:17-39`).
- The reserve guarantees tmp + fsync + rename never starts without room for
  the largest expected write (one 4 MB chunk + manifest copies + tar
  window).

## Source map

| Concern | Source of truth |
|---|---|
| Design rationale for all of the above | `docs/decisions.md` |
| Pipeline, CLI shapes, rules, measured SLA | `README.md`, `bin/moltarc.ts:35-53` |
| Full CLI reference (15 subcommands) | `docs/cli.md` |
| Module ownership table | `docs/modules.md` |
| Numeric contracts and gates | `docs/contracts.md` |
| Benchmark method behind the ratios | `docs/bench.md` |
| Back-compat surface | `docs/compat.md` |
