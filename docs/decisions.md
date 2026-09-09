# molt decisions — why each load-bearing choice

Date: 2026-09-06. Each entry grounded in code + `bench/measured.json` / `docs/bench.md`.
Reversed-consequence states what breaks, not opinion.

## 1. Chunk 1–4MB bounds, ~2MB target

- Decision: seal packs per-table batches to `TARGET_BYTES` (2MB); flush gates on target, hard tail rule at `MAX_BYTES` (4MB); `MIN_BYTES` (1MB) documents the small-chunk floor. `src/seal.ts:15-17`, packing/probe loop `src/seal.ts:285-336`.
- Context: mixed corpus (6000 rows, seed 7) seals 2.52MB input into 3 warm chunks, 246723B (`bench/measured.json` perf; `docs/bench.md` seal 6.9MB/s in 350ms; warm bytes jitter ±~30B run to run, ratio steady at 10.2x). ~0.8MB compressed per chunk keeps find to ~1 chunk fetch per lookup (`findFetched: 11` over 6 probed ids).
- Alternatives rejected: 64KB chunks (manifest with thousands of entries, shard/sparse index bloat, ship delta fans out); 64MB chunks (find pays full read+crc+decode per lookup; a corrupt chunk quarantines 64MB instead of ~1MB, cf. `src/verify.ts:81-92` quarantine-one design).
- If reversed: tiny chunks → manifest/shard/sparse growth + N-fetch finds; huge chunks → warm p50 find (~13.60ms in `bench/measured.json`) regresses linearly with chunk bytes, quarantine blast radius grows with chunk size.

## 2. zstd only, no LZ4

- Decision: `compressFrame` tries zstd, then zstd+dict, falls back to deflate (`src/chunk.ts:118-129`); decode accepts zstd/deflate/none (`src/chunk.ts:145-151`). No LZ4 codec exists.
- Context: measured ratios come from zstd alone — 34.5x repetitive text, 10.2x mixed (`bench/measured.json` mixed; `docs/bench.md`), 1.05x on raw jpeg proving incompressible passthrough. One codec keeps `decodeHeader` + `DECOMPRESS_MAX_BYTES` cap (`src/chunk.ts:133`) a single audit surface.
- Alternatives rejected: LZ4 as default (faster decode, ~2-3x worse ratio on text — would forfeit the 34.5x/10.2x warm-size wins that make ship deltas 1791B viable); dual zstd+LZ4 codecs (second decode path + per-chunk codec negotiation for no measured need).
- If reversed: LZ4 default inflates every warm chunk toward raw size; dual-codec doubles decode-path bug surface and breaks the N-2 compat error contract (`src/chunk.ts:151`).

## 3. Dict gate: train only when sample ≥4x, ≥100 rows, non-blob, 32KB cap

- Decision: `trainTableDict` returns null unless `bodies ≥ 100`, `sampleRatio ≥ 4`, table not matching `BLOB_TABLE_RE`; dict capped at `DICT_MAX_BYTES` 32KB from first 10k rows (`src/dict.ts:10-11,44-62`; gate comment `src/dict.ts:22-23`).
- Context: dict bench (12000 rows, seed 7) saves 2003B / 1.8% (`bench/measured.json` dict) — small because zstd already hits 30.3x plain. Photo bench shows jpeg at 1.05x raw, so blob tables would train a useless dict; hence the blob exclusion (`src/dict.ts:35-42`).
- Alternatives rejected: always-train (a dict file + `DICT_FLAG` lookup per chunk for ~0% on blobs/jpegs); higher gate (8x — kills the measured 1.8% on real repetitive text); bigger dict (diminishing returns past ranked-line working set, more relay bytes via copy-if-missing `src/ship.ts:158-161`).
- If reversed: gate removed → dict files on incompressible tables, wasted relay copies + decode lookups; gate raised → the only measured dict win disappears.

## 4. Bloom 2048 bits, k=3, scaled reads

- Decision: legacy entries use `BLOOM_BITS = 2048` (`src/manifest.ts:8`), 3 hashes (`src/manifest.ts:81-99`); `bloomBitsForRows` scales newer chunks to ≥ rows×10 bits (`src/find.ts:155-161`); reader mods by actual stored length (`src/find.ts:169-173`).
- Context: perf find fetches 11 while pruning 8 across 6 probed ids (~1-2 fetches per lookup; `bench/measured.json` `findFetched: 11, findPruned: 8`) — min/max range + bloom chain (`src/find.ts:185-225`) is what keeps the warm p50 at ~13.60ms.
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
- Context: warm find is ~13.60ms p50 over 6 probed ids × 20 iters (cold-median first lookup 17.17ms; `bench/measured.json`); cold scan is O(segments) tar decode over already-zstd members (`src/cold.ts:1-2`) — slower by construction.
- Alternatives rejected: unified find (every miss pays a tar scan; typo'd ids cost seconds); silent cold fallback (operators can't tell a ~14ms hit from a multi-second scan in logs).
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

## 10. P2P delta sync: have/want + blocks + resume journal

- Decision: peers exchange `summaryOf` have-lists (non-quarantined only) in hello/welcome, the learner sends a `want` delta of missing shas, the server streams meta/block/end per chunk, and the learner resumes partials from `.p2p-state-<sha12>.json` journals + `.part` files (`src/p2p.ts:90-99` summary, `src/p2p.ts:124-146` journal scan, `src/p2p.ts:694-743` hello/welcome/want, `src/p2p.ts:399-438` serve, `src/p2p.ts:226-253` storeBlock, `src/p2p.ts:167-224` applyComplete).
- Context: `summaryOf` filters quarantined chunks (`src/p2p.ts:93-95`); welcome-side skip vs want runs on a local sha set with journal offsets preserved (`src/p2p.ts:728-742`); server re-hashes bytes before serving (`src/p2p.ts:414`) and the learner re-hashes + `verifyChunk`s after install (`src/p2p.ts:177,197-198,220-221`); caps bound abuse (`MAX_CHUNK_BYTES` 4MB, `MAX_SESSION_BYTES` 256MB, `MAX_HAVE` 50000 at `src/p2p.ts:256-260`, enforced `src/p2p.ts:524,804-838,588-594`).
- Alternatives rejected: full-mirror sync (re-ships bytes the learner already has; the have/want delta is what keeps per-run bytes to the missing set); stateless receiver without journals/`.part` (any kill restarts every chunk from 0 instead of resuming at the journaled offset); trust-the-manifest apply (a forged `meta.entry` would install without the post-transfer sha + chunk-verify gate).
- If reversed: no have/want → every sync pays full-archive bytes; no journal → mid-transfer kills lose all partial progress; no post-transfer hash+verify → corrupt/forged wire bytes enter warm and poison the manifest merge (`src/p2p.ts:222`).

## 11. Timetravel as-of: seq/ts fold with range prune, fail-closed on corrupt

- Decision: `queryAsOf` takes exactly one of seq|ts, prunes chunks by `seqMin`/`tsMin` (plus window floors), folds latest-row-per-id in `seqMin` order, throws on corrupt kept chunks, skips missing files loudly via `proof.skippedMissing` + `assertTimeTravelComplete` (`src/timetravel.ts:66-136` fold, `src/timetravel.ts:89-104` prune, `src/timetravel.ts:118-123` fail-closed, `src/timetravel.ts:145-148` assert).
- Context: exactly-one-of-seq|ts plus window/mode cross-checks at `src/timetravel.ts:69-76`; bloom explicitly skipped — no id predicate, range prune is the sole pre-decode filter (`src/timetravel.ts:85-88`); >1000 kept chunks warn (`src/timetravel.ts:105`); winner rule is highest seq, ts breaks ties (`src/timetravel.ts:129-130`); rows sort by seq then id (`src/timetravel.ts:133`).
- Alternatives rejected: bloom pre-filter (no id predicate exists — bloomCheckScaled is point-query only, would add lookups for zero prune); silent skip of corrupt chunks (returns a partial fold disguised as history — the damage contract `src/timetravel.ts:10-21` refuses this); throw-on-missing (a pruned-away warm file would make history unreadable instead of partial-but-labelled).
- If reversed: corrupt-skip → callers treat a partial fold as authoritative state; missing-throw → any rotated chunk breaks all as-of reads; bloom-first → wasted decode-path lookups with no predicate to check.

## 12. SQLite ext: zero-format-code surface, subprocess canonical reader

- Decision: SQL exposes exactly two scalars — read-only `moltarc_find(outDir, trxId)` returning row JSON or NULL, and `moltarc_seal(hotDb, outDir[, table])` returning SealResult JSON — with all chunk bytes parsed in `src/seal.ts` + `src/find.ts` via import (TS) or `bun ext/moltarc.ts` subprocess (C); no native codec exists (`ext/moltarc.ts:1-16` reuse rule, `ext/moltarc.ts:37-61` functions, `ext/moltarc.c:11-33` contract, `ext/moltarc_hook.c:1-12` hook rule).
- Context: find maps miss AND index errors to SQL NULL, never an exception across the value boundary (`ext/moltarc.ts:37-53`, `ext/moltarc.c:63-75`); seal safety is inherited — never deletes input, watermark-idempotent, reserve-refusing (`ext/moltarc.c:15-18`, `ext/moltarc.ts:55-61`); subprocess cost is one bun spawn per call with stdout capped at 8MB `OUT_CAP` and exit 1 == SQL NULL (`ext/moltarc_hook.c:23`, `ext/moltarc.ts:67-85`).
- Alternatives rejected: native C chunk codec (second implementation of the 64B UMK1 header + columnar frame + zstd/deflate + crc/sha — guaranteed format fork); SQL errors on miss (breaks `WHERE moltarc_find(...) IS NULL` idioms; miss is data, not failure); uncapped stdout pipe (a giant SealResult JSON could OOM the sqlite host).
- If reversed: native codec → two readers drift and the N-2 compat contract splits; error-on-miss → every point lookup needs exception handling instead of `IS NULL`; uncapped pipe → unbounded host memory per call.

## 13. Sensor lossy log + ticket single-spend voucher (import-only reuse)

- Decision: sensor stays pure in-memory math (ts-sorted one-pass bucket downsample, two-pass z-score flags with clean-baseline re-score, hot/cold/quarantine routing, bloom-over-anomalous-ids bridge) and ticket stays an in-memory exact-set voucher (deterministic id, O(1) redeem, reconcile report, explicit persist/restore); both reuse chunk/manifest/hash primitives by import and never fork them (`src/sensor.ts:1-6` rule, `src/sensor.ts:47-77` downsample, `src/sensor.ts:87-118` flags, `src/sensor.ts:128-146` routing, `src/sensor.ts:148-156` bloom, `src/ticket.ts:1-4` rule, `src/ticket.ts:71-77` redeem, `src/ticket.ts:90-98` reconcile).
- Context: first `minBaseline` points never flag and std-0 flags any deviation (`src/sensor.ts:93-99`); pass 2 excludes pass-1-flagged points from baselines so one spike cannot mask the next (`src/sensor.ts:108-116`); `anomalyToCold: false` leaves fresh-flagged points hot AND unquarantined by design (`src/sensor.ts:124-127`); ticket ids are `t-<sha12(value:issuedAt:nonce)>` (`src/sensor.ts:182-184` seriesHash pattern; `src/ticket.ts:33-39`); unknown ids reject before attempt counting (`src/ticket.ts:72-73`); restart without `toJSON`/`fromJSON` re-enables spent vouchers (`src/ticket.ts:41-43,100-131`).
- Alternatives rejected: sensor as second chunk codec (duplicates header/crc/zstd paths for summaries that already round-trip via `bucketsToRows`+`packSensor`, `src/sensor.ts:158-178`); bloom-based double-use detection (probabilistic spendability is wrong — redeemed set is exact O(1)); auto-persisting ticket store (hides the durability contract; explicit snapshot keeps the restart-loses-history rule loud).
- If reversed: sensor codec fork → summary bytes drift from canonical chunks; bloom tickets → false-positive spend refusals or false-negative double-spends; silent ticket durability → restarts silently re-spend vouchers.

## 14. Migrate: forward-only rescan, backup-first, idempotent

- Decision: old archives (version < 1 or entries missing v1 index fields) migrate by byte-backing-up the primary manifest, rescanning warm chunks into a fresh v1 manifest (chunk files untouched, cold listing preserved, `createdAt` carried over), and atomically swapping the dual copy + sidecars; current archives plan clean and rewrite nothing (`src/migrate.ts:12-13` version/backup, `src/migrate.ts:75-97` plan, `src/migrate.ts:119-144` apply).
- Context: dry-run reports only and never writes (`src/migrate.ts:120-124`); backup writes the `.pre-migrate` copy only when absent, preserving the first pre-migration bytes (`src/migrate.ts:129-130`); cold tars stay on disk — only the listing is carried (`src/migrate.ts:131-136`); missing cold[]/seq+crc/shards are info-only and heal on next save, so only genuinely old shapes set `needs` (`src/migrate.ts:70-74`).
- Alternatives rejected: in-place manifest field patching (a kill mid-patch leaves a half-versioned index with no rollback bytes); chunk-file rewrite during migrate (risks row/seq/ts/sha history for an index-only upgrade); migrate-on-every-save (rewrites current manifests pointlessly instead of planning clean).
- If reversed: no backup → failed rescan destroys the only readable index; chunk rewrites → history semantics change under a supposedly index-only op; always-migrate → every save pays a full warm rescan.

## 15. Readonly auditor: wrapper-only handle, writes fail loud

- Decision: `openArchiveReadOnly` returns a frozen handle whose reads delegate to find/verify/gc and whose fourteen mutating ops throw a `readonly: <op> refused` error naming the dir; the module never imports seal/ship/cold write paths (`src/readonly.ts:1-3` rule, `src/readonly.ts:40-62` constructor, `src/readonly.ts:13-15` refusal).
- Context: read surface is find + verify + verifyFull + status (`src/readonly.ts:43-46`); mutating args are accepted as `unknown[]` so callers fail at runtime with the read-only message instead of a type error (`src/readonly.ts:24-37`); `Object.freeze` seals the handle (`src/readonly.ts:61`).
- Alternatives rejected: flag-threaded readonly (every write path must check a boolean — one missed check writes; import absence makes writes structurally impossible); type-level-only readonly (erased at runtime — JS callers still mutate); silent no-op mutators (operators believe a seal/forget happened).
- If reversed: flag checks → any new write path defaults to writable until someone remembers the flag; no-op writes → believed-but-lost seals; unfrozen handle → callers monkey-patch the guard away.

## 16. Alerts: unacked-escalation report, read-only, missing-manifest throws

- Decision: `checkUnacked` reports ok/warn/critical over unacked + quarantined + free-bytes dimensions with reasons and an `unknown[]` list for unreadable dimensions; it throws when neither manifest copy parses (version + chunks array), because a rebuilt-from-filenames zero-count would otherwise report healthy (`src/alerts.ts:52-95` body, `src/alerts.ts:42-50` gate, `src/alerts.ts:59-61` throw).
- Context: defaults are warn/crit 5/20 unacked, 1/3 quarantined, 2x/1x `RESERVE_BYTES` free (`src/alerts.ts:29-32,53-58`); unacked comes from `statusInfo`, quarantined from a manifest scan, free from statfs unless the `freeBytes` test seam overrides (`src/alerts.ts:65-76`); escalation is sticky-critical with per-dimension reasons (`src/alerts.ts:80-93`); unreadable status/manifest degrade to `unknown` + warn, not zero + ok (`src/alerts.ts:67-74,93`).
- Alternatives rejected: warn-on-missing-manifest (a torn dir pages nobody — throw forces the operator path); zero-on-unreadable-dimension (unmeasured reads as healthy, the exact failure this module exists to catch); write-side alert acking (alerts stay read-only per `src/alerts.ts:1`; acking belongs to ship/sweep).
- If reversed: missing-manifest ok → fresh/torn archives page as healthy with zero counts; silent-zero dimensions → dead statfs hides a full disk; alert-time writes → the monitor mutates the archive it watches.

## 17. Append-only fast path: merge entries, no warm rescan

- Decision: seal and p2p-receive merge caller-scanned entries into the best crc-valid manifest copy (dedupe by filename, existing entries win, filename sort, atomic dual-copy save) instead of rescanning warm (`src/manifest.ts:603-617` function; seal call `src/seal.ts:494-524`; p2p calls `src/p2p.ts:182-186,220-222`).
- Context: the seal watermark already covers each flushed chunk, so a kill before the append only repeats manifest work on retry (`src/seal.ts:494-498`); p2p already-applied bytes merge best-effort and return `skipped` (`src/p2p.ts:178-199`); seq+crc still bump through the same atomic save as a full rebuild (`src/manifest.ts:605,615`).
- Alternatives rejected: full `buildManifest` warm rescan per seal (O(chunks) directory + header reads on every batch for an identical result); blind push without dedupe (retries duplicate entries; existing-wins keeps idempotence); unsorted append (manifest order drifts from rebuild order, breaking diffability).
- If reversed: rescan-per-seal → seal cost grows with archive size instead of batch size; no dedupe → kill-retry duplicates chunk entries; unsorted → every append perturbs ordering for no reason.

## 18. v0.20.0 hardening: PSK handshake + seal.lock + migrate guard + gc-relay

- Decision: wire security is a 32-byte PSK (explicit opt wins, else `MOLTARC_PSK` env) framing every message as HMAC-SHA256(json)+`.`+json verified on raw bytes BEFORE parse, plus per-message auth fields and a sha256(token) allowlist; concurrency is a `seal.lock` pid file with stale-dead-holder reclaim; downgrade safety is `assertMigrated`/`requireMigrated` on every mutating path; deletion safety is relay-acked-only gc (`src/p2p.ts:282-310` psk resolve, `src/p2p.ts:341-363` frame/unframe, `src/p2p.ts:317-339` per-message auth, `src/p2p.ts:267-271` allowlist, `src/seal.ts:270-332` lock, `src/migrate.ts:103-113` guard, `src/gc.ts:43,83-100` relay-acked sweep).
- Context: PSK accepts 64-hex / 32-raw / 32-base64 and throws on malformed non-empty values (`src/p2p.ts:283-297`); unguarded nodes warn trusted-LAN-only at startup (`src/p2p.ts:473`); node opts document the LAN fallback (`src/p2p.ts:29-36`); lock uses O_CREAT|O_EXCL before any watermark read, reclaims only on ESRCH, keeps EPERM/unparsable/same-pid locked (`src/p2p.ts:444-471` guarded-mode wiring; `src/seal.ts:307-315` create, `src/seal.ts:284-299` stale check); reads stay tolerant and bypass the migrate guard per compat N-2 (`src/migrate.ts:103-106`); gc apply without `relayDir` throws and unknown-ack orphans retain (`src/gc.ts:85,95-100`, orphan fields `src/gc.ts:52-58`).
- Alternatives rejected: TLS-only transport ([INFERENCE] heavier deploy surface for a tool that syncs over LAN relays; HMAC framing covers integrity/auth without cert management); advisory in-process mutex instead of lockfile (two processes race watermarks — the lock must live on disk); gc-by-refcount-only (deletes unshipped working data after forget-before-ship races — relay ack is the backstop).
- If reversed: no PSK → anyone on the network pushes chunks into warm; no lockfile → concurrent seals watermark-race and fork the manifest; no migrate guard → a new binary half-upgrades an old manifest in place; refcount-only gc → unshipped orphans delete before the relay acks them.
