# changelog

User-visible changes per tag, from `git log`. Test-only hardening with no
behavior change is marked as such.

## v0.21.2

- No behavior change: npm publish bookkeeping only (`publish npm latest`).

## v0.21.1

- No behavior change: publish pipeline (OIDC unshadow) plus branch merges.

## v0.21.0

- CLI +3: `p2p-sync`, `asof`, `migrate`; `src/index.ts` re-exports all ten
  modules (sensor/ticket/bundle/alerts/readonly/cas/thumb stay library-only).
- Tarball diet: `files` limits publish to src/bin/docs-core (3.6MB → 81KB);
  gifs/tests/bench stay in git only.
- P2P PSK rotation: `MOLTARC_PSK` comma-separated list, primary first,
  verify tries each; single-key input unchanged.
- Seal lock proven under real two-process contention (spawn test).
- Dict SLA stated as measured range with seed, not a single number.

## v0.20.0

- 39 temuan audit diperbaiki + dikunci regression test (suite 246/246,
  `tsc --noEmit` bersih). Yang user-visible:
- Dedupe key jadi `table:device:seq`: baris sah beda-tabel tak lagi terbuang.
- Bloom truncated fail-open: chunk hidup tak lagi di-prune saat buffer pendek.
- Alerts fail-loud: arsip rusak/tak terbaca throw, bukan lapor `ok` nol.
- Foto lifecycle: `foto/` ikut verify + ship opt-in + sweep; readTar cek
  checksum ustar di level tar.
- P2P: HMAC-SHA256 per blok (`MOLTARC_PSK`) + node identity; tanpa PSK
  fallback trusted-LAN-only tertulis.
- `seal.lock`: seal konkuren kedua gagal berisik, bukan watermark race.
- Guard migrasi: 7 write-path panggil `assertMigrated()`, binari baru
  menolak rewrite manifest lama in-place.
- `gc --apply` wajib relay: hanya hapus yang sudah di-ack (rule 7); tanpa
  relay error jelas. `forget` bilang byte tetap sampai gc + coldg apply.
- Validasi seal: seq negatif/9-digit, `ts` non-finite (NaN), kolom sqlite
  hilang, sidecar terpotong — semuanya malformed berisik di pintu.
- Redeem O(1) amortized (Bloom cache), nonce `crypto.randomUUID`.

## v0.19.0

- Traversal gates: chunk/sha/owner/bundle names reject `/`, `\`, `..`
  so relay and archive paths can never escape their directories.
- Chain gaps: `verifyFull` keeps hard chain breaks fatal and reports
  forward seq skips as `chainGaps` warnings only.
- Foto ship: `ship --include-blobs` sends `foto/*.bin` sidecars (small
  copy-if-missing, large resumable) with thumb companions; text ships
  unchanged without the flag.
- PSK: opt-in P2P token allowlist (`allowPeers` holds `sha256(token)`);
  empty serves anyone (LAN default), non-empty rejects unknown peers.
- Shard pointers: root `chunks[]` stays complete; additive per-month
  `shards`/`pointers` plus best-effort `manifest-YYYY-MM.json` sidecars
  speed finds, readers fall back to root on skew.
- Library modules (no CLI yet; `p2p-sync`/`asof`/`migrate` commands arrive
  in v0.21.0): P2P delta sync over websocket with resume + idempotent apply
  (`src/p2p.ts`); as-of query with chunk proof (`src/timetravel.ts`);
  forward migrator with dry-run + write guard (`src/migrate.ts`); read-only
  auditor handle (`src/readonly.ts`); unacked escalation alerts
  (`src/alerts.ts`); sensor/ticket/bundle kit (`src/sensor.ts`,
  `src/ticket.ts`, `src/bundle.ts`); SQLite extension reference in `ext/`
  only; seal via `appendEntries` with rebuild fallback.

## v0.18.1

- No behavior change: concurrent-writer proof (three parallel seal
  processes) plus a cold-only restore drill, both test-only.

## v0.18.0

- Sharded manifest: additive per-month `manifest-YYYY-MM.json` sidecars plus
  a persisted sparse index make `find` shard-aware; readers fall back to
  root `chunks[]` on any skew.
- Foto previews: quarantined foto sidecars gain `thumb-<sha>.jpg` +
  hash-link `.json` companions (`src/thumb.ts`, `src/cas.ts` fork store).

## v0.17.0

- No user-visible change (version bookkeeping; no commits in range).

## v0.16.1

- CLI gains `gc`: orphan sweep, dry-run by default with relay passthrough
  (`moltarc gc <outDir> [relayDir] [--apply] [--deep-foto]`).

## v0.16.0

- `mergeCold` streams tar writes through a 1MB window: same bytes, far less
  peak memory on large merges.

## v0.15.0

- Seal: bounded watermark (kill loses only the unflushed tail), malformed
  abort past 1% of input, foto gate (large base64 bodies become
  `foto/<sha>.bin` sidecars + hash refs), size-probe encodes.
- Manifest: seq+crc envelope with best-valid-copy load, BOM strip, cold
  kept across rebuilds, `appendEntries` fast path.
- Find: manifest cache, sparse-index jump, cold opt-in, scaled bloom, plus
  a missing-row counter.
- Verify/repair: atomic strict manifest checks with link enforcement;
  chunk decode cross-checks the header with decompress caps and refuses
  blob-table dict training.
- Cold/GC: unacked-safe sweep, orphan dict GC, dict-carrying segments,
  reserve fail-closed; `ship` relay waste fixes.

## v0.14.0

- Renames the package and CLI from `molt` to `moltarc` (`bin/moltarc.ts`).
- Test-only hardening with no behavior change: every test declares an
  explicit timeout instead of relying on the 5s default, scratch dirs are
  collision-safe under parallel workers, and spawned CLI children in the
  soak test can no longer crash the worker on spawn/kill races.

## v0.13.1

- No behavior change: removes a stray committed package lockfile.

## v0.13.0

- No behavior change: aligns `package.json` version with git tags.

## v0.12.0

- No behavior change: drops a wall-clock perf assert that flaked under
  suite contention (soak test).

## v0.11.1

- Fixes seal wiping the cold listing (`cold` kept across seal rebuilds);
  ship reports warm chunks missing from disk instead of silently skipping.

## v0.11.0

- Adds the perf bench (`bun bench/perf.ts`): seal MB/s, full vs delta ship
  bytes, and single-chunk find latency recorded in `docs/bench.md` and
  `bench/measured.json`.

## v0.10.0

- No behavior change: adds a seeded randomized soak test that seals,
  ships, finds, and garbage-collects random workloads while checking
  archive invariants.

## v0.9.1

- Fixes silent multi-device data loss: seal now tracks a per-device
  `sealed_upto_seq` watermark, so rows from a slow device are no longer
  dropped under another device's higher sequence.
- `forget` and `gc` now delete only relay-acked chunks; unacked data is
  never removed.

## v0.9.0

- Proves backward compat: chunks sealed by v0.5-era writers (ver-0
  headers, deflate codec) still read on current `find`/`verify`.
- Adds `docs/compat.md` pinning the N-2 codec rule (`UMK1` magic,
  header/frame tolerance, manifest defaults).

## v0.8.0

- Adds `molt verify`: full chunk walk (crc32c + sha256 per chunk,
  manifest cross-check).
- Adds `molt repair`: refetches corrupt chunks by hash, quarantines the
  rest to 1/150 of history instead of total loss.

## v0.7.0

- Adds cold archive: `merge`/`coldg` packs warm chunks into
  `cold/seg-*.tar` and prunes dead members with a manifest rewrite.
- README SLA tables are now written by the bench scripts from measured
  runs, with a test failing on any hand-edited ratio.

## v0.6.0

- Adds `molt gc` orphan sweep plus `molt status` output.
- Seal refuses to start without reserve free space (reserve seal guard).

## v0.5.0

- Fielog interop: raw `kasir.log` cashier events (`bayar`/`undo` +
  `nominal`) seal with no manual conversion.
- Adds dict on/off delta bench proving the trained-dict saving.
- CLI gains resume: interrupted `ship` continues from the offset journal.

## v0.4.0

- Adds photo bench: 50 real JPEGs sealed beside text, proving jpeg bytes
  are incompressible (~1.05x raw) so photo bytes stay out of the
  mandatory archive as hash refs.
- Adds the `molt` CLI (`seal`/`ship`/`find`/`status`).
- Adds per-table 32KB zstd dicts, trained when the sample compresses 4x+.

## v0.3.0

- Adds chunk frame validation on decode (rejects truncated/tampered
  frames instead of mis-decoding).
- Adds fault-injection tests (bit-flip, truncated chunk, missing relay).
- Adds the kasir demo example.

## v0.2.0

- Seal reads hot SQLite directly (`bun:sqlite`, tables `tx`/`log`) in
  addition to JSONL WAL export.
- Adds the mixed-corpus bench (60% repetitive tx / 25% notes / 15% blob
  refs) with measured archive ratios.
- Adds the end-to-end example (`seal` -> `ship` -> `find`).

## v0.1.0

- First archive pipeline under `bun test`: hot WAL seals into immutable
  warm columnar chunks (~2MB, `UMK1` header, crc32c + sha256 per chunk),
  `ship` sends only missing chunk hashes with resume, `find` fetches one
  chunk via manifest min/max + bloom prune, corrupt chunks quarantine
  instead of failing the archive.
