# changelog

User-visible changes per tag, from `git log`. Test-only hardening with no
behavior change is marked as such.

## v0.14.0

- Renames the package and CLI from `molt` to `moltarc` (`bin/moltarc.ts`).
- Test-only hardening with no behavior change: every test declares an
  explicit timeout instead of relying on the 5s default, scratch dirs are
  collision-safe under parallel workers, and spawned CLI children in the
  soak test can no longer crash the worker on spawn/kill races.

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
