# troubleshooting

Symptoms in the order you meet them, with the exact error and the fix.
All behaviors below are enforced in `src/`; command shapes in `docs/cli.md`.

## `seal` refuses: 50 MB reserve

```
seal refused: only <n> bytes free, need 50MB reserve (free up space and retry)
```

`checkReserve` (`src/gc.ts`) runs before any seal/merge/sweepCold-apply
write so a chunk, watermark, or manifest copy never half-writes. Free space
(or point `outDir` at a bigger disk) and retry. `gc` sweep itself only
deletes, so it never trips the reserve — run it to reclaim orphans first.

## `seal` reports malformed rows / aborts

Per-line JSON that fails `normRow` (bad/missing `seq`, non-integer `ts`,
seq outside 1 … 99 999 999) counts as malformed, never crashes the seal
(`src/seal.ts`). Past the 1 % share the seal aborts loud instead of
laundering a corrupt feed. Fix the producer (see field aliases in
`docs/interop.md`), or pass `--table` when rows lack a table key.

## Second `seal` fails on `seal.lock`

Concurrent seals are refused, not interleaved: the loser exits loud and the
winner's per-flushed-chunk watermark stands. Re-run after the first seal
finishes; re-seal is idempotent (already-sealed rows skip).

## `verify` FAILs

`verify` prints per-chunk `CORRUPT`/`MISSING`/`QUARANTINED` lines plus chain
breaks, and exits 1. `GAP …` lines are forward-seq-skip warnings only — they
do not fail the walk. For real corruption: `moltarc repair <outDir>
<relayDir>` refetches good bytes by hash from the relay; what the relay
cannot supply stays quarantined (1 chunk lost, archive intact). If the relay
also lacks it, that chunk's rows are gone — re-seal them from the hot source.

## New binary refuses old archive: migrate guard

```
… needs migrate to v1 (run: moltarc migrate <outDir>) …
```

Seven write paths call `assertMigrated()`/`requireMigrated()` (`src/migrate.ts`): a new binary
never rewrites an old manifest in place. Run `moltarc migrate <outDir>
--dry-run` to inspect, then without the flag (backup lands in
`manifest.pre-migrate.json`), then retry. Chunk files are never touched.

## `gc` deletes nothing / `forget` refuses

Both are fail-closed on purpose (rule 7, `docs/contracts.md`):

- Bare `gc` is a dry-run: add `--apply` to delete, and pass `relayDir` —
  apply without it throws, without it orphans are retained as
  `skippedUnacked`.
- `forget` needs `relayDir` and aborts atomically on any unacked name: `ship`
  first, then forget.
- `forget` never frees bytes by itself: run `gc --apply`, then
  `coldg --apply` for cold segments.

## `find` throws: not in warm

`findTrx` searches warm only (`src/find.ts`); cold rows need the
library-level `findCold`. A `table:device:seq` compound id also matches
(`matchRowId`), so prefer the plain row id. After `restore-from-cold
--apply`, find caches are cleared automatically.

## `check` exits 1 or 2

Warn/exit-1 at 5 unacked or 1 quarantined or <100 MB free; critical/exit-2 at
20 unacked or 3 quarantined or <50 MB free (`src/alerts.ts`). Reasons print
one per line. A throw about "no readable manifest copy" means both manifest
copies are missing/garbage — restore them (relay copy, backup, or
`restore-from-cold`) instead of re-sealing over the dir.

## `p2p-sync` gets `not allowed` / nothing arrives

Non-empty `allowPeers` rejects token-less peers and wrong tokens; pass the
matching `--token`. Without `MOLTARC_PSK` both ends silently run
trusted-LAN-only — fine on a cable, wrong across the internet. Syncs that
receive nothing but report no failure usually mean the peer holds only
quarantined entries (never served) or everything is already acked.

## Full-suite flakes

Kill-timing and port-reuse flakes under one giant `bun test test/` run are
load contention, not regressions (`docs/bench.md`): re-run the single scoped
file (`bun test test/<file>.test.ts`). CI splits this for you —
`bun run test:stable` on every push/PR, `bun run test:heavy` nightly
(`.github/workflows/ci.yml`, `heavy.yml`).
