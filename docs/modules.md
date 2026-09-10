# modules

Source map for the whole repo. Library entrypoint is `src/index.ts`
(re-exports the archive API; sensor/claim/bundle/readonly/cas/thumb
stay library-only — no CLI; `alerts.checkUnacked` powers CLI `check`).
CLI entrypoint is `bin/moltarc.ts`.

## Pipeline core

| Module | Owns |
|---|---|
| `src/seal.ts` | Hot WAL/JSONL/SQLite → warm columnar chunks (delta/RLE/dict + zstd); per-device watermark, `PHOTO_INLINE_LIMIT_BYTES`, malformed abort, probe encodes |
| `src/chunk.ts` | 64 B header (`UMK1`, codec, rows, `crc32c`, `dict_id`), columnar frame (delta seq/ts, dict device, RLE body), `DECOMPRESS_MAX_BYTES` cap |
| `src/manifest.ts` | Atomic dual-copy manifest + envelope (seq/crc), min/max + bloom entries, monthly shard sidecars + sparse index, rebuild-from-filenames, `appendEntries` fast path |
| `src/dict.ts` | Per-table 32 KB zstd dicts; trains only on ≥100 bodies with ≥4x sample ratio, never on blob tables |
| `src/ship.ts` | Delta-by-hash to a relay dir, chunked resume journal, text-first lanes, photo sidecars on `--blobs` |
| `src/find.ts` | Warm point query: shard/sparse jump → min/max prune → scaled-bloom prune → single-chunk fetch; `findCold` opt-in for cold |
| `src/verify.ts` | `verifyChunk`/`verifyAll`/`verifyFull` (hash walk + chain), `quarantine`, `repairByHash`/`repairAll` |
| `src/cold.ts` | `mergeCold` (warm → `cold/*.tar`), `forgetChunks` (acked-only), `sweepCold` (prune/repack), `writeTar`/`readTar` with member caps |
| `src/gc.ts` | Orphan `sweep` (dry-run default, relay-ack deletes), `statusInfo` meter, `RESERVE_BYTES` guard + `checkReserve` |

## Sync, history, upgrade

| Module | Owns |
|---|---|
| `src/p2p.ts` | WebSocket delta sync: summaries, want-by-sha, base64 blocks, journal resume, idempotent apply; HMAC-SHA256 PSK frames, token allowlist |
| `src/timetravel.ts` | Read-only `queryAsOf` (seq or ts) with chunk proof; fail-closed on corrupt, partial-marked on missing |
| `src/migrate.ts` | Forward migration to manifest v1 (`planMigration`/`migrate`), `CURRENT_MANIFEST_VERSION`, `assertMigrated` write guard |
| `src/readonly.ts` | `openArchiveReadOnly`: find/verify/status work, every mutating op throws |
| `src/alerts.ts` | `checkUnacked` escalation report (ok/warn/critical) over unacked + quarantine + free space |

## Safety rails and media

| Module | Owns |
|---|---|
| `src/guard.ts` | `assertSha`, `assertChunkName` (traversal gate), `atomicWrite` (tmp + fsync + rename) |
| `src/thumb.ts` | Photo previews: 32 px JPEG + hash-link meta beside the full bytes; input/dimension caps |
| `src/cas.ts` | Content-addressed blob store (`casPut`/`casGet`, owner refcounts, `casGc`) |
| `src/bundle.ts` | Atomic 1-text + N-refs pack (`packBundle`/`verifyBundle`, hash-linked) |
| `src/claim.ts` | Hash-id claim issuance + use (`issueClaim`, double-use guard) |
| `src/sensor.ts` | Numeric-series kit: downsample, anomaly flags, hot/cold/quarantine routing, chunk bridge |

## Edges

| Path | Owns |
|---|---|
| `bin/moltarc.ts` | The CLI: 15 subcommands over archive dirs (full reference in `docs/cli.md`) |
| `ext/moltarc.ts` | SQLite extension reference (TS): read-only `moltarc_find` + `moltarc_seal`, zero format code |
| `ext/moltarc.c`, `ext/moltarc_hook.c` | Native hook: every SQL call shells out to `bun ext/moltarc.ts` (`MOLTARC_BUN`, default `bun`) |
| `ext/fetch-sqlite.ts` | Fetches the SQLite amalgamation for extension builds (kept out of git) |
| `bench/mixed-corpus.ts` | Mixed-corpus SLA bench, rewrites the README Measured table with `--write-readme` |
| `bench/photo-bench.ts` | 50-real-JPEG bench, rewrites the Photo SLA table |
| `bench/dict-bench.ts` | Dict off-vs-on bench, rewrites the Dict SLA table |
| `bench/perf.ts` | Seal/ship/find timings, recorded under `perf` in `bench/measured.json` |
| `examples/e2e.ts` | Multi-device feed: 1200 rows seal → ship → find (`bun run e2e`) |
| `examples/universal-demo.ts` | Generic event feed, 50 rows, prints shrink ratio (`bun run demo`) |
| `examples/ledger-demo.ts` | Entry-ledger feed, 50 rows, one domain example (`bun run ledger`) |
| `examples/dashboard.ts` | Timetravel polling demo: windowed recent-state fold polled N times |

Tests mirror modules one-to-one under `test/` (`seal ↔ seal*.test.ts`,
`p2p ↔ p2p*.test.ts`, …) plus cross-cutting `e2e*.test.ts`, `interop.test.ts`,
`readme.test.ts` (README numbers must regenerate from `bench/measured.json`).
