# bench — measured numbers, no estimates

All ratios below come from `bench/measured.json`, written by the bench
scripts themselves. Perf timings come from `bun bench/perf.ts`
(recorded under the `perf` key). Re-run on your machine and compare;
timings move, ratios should not.

## machine

- `win32 10.0.26100 x64 | AMD Ryzen 5 PRO 5650U with Radeon Graphics x12 | bun 1.4.0`

## sla recap (from readme, measured)

| corpus | input | warm archive | ratio |
|---|---|---|---|
| repetitive tx text (60% repetitive tx, 6000 rows, seed 7) | 1.64MB | 48.6KB | **34.5x** |
| mixed text+notes+refs (blob bytes excluded, 6000 rows, seed 7) | 2.40MB | 240.9KB | **10.2x** |
| photo blobs (3.23MB sidecar, lazy/on-demand) | excluded | excluded | n/a (incompressible) |
| real jpeg bytes, raw zstd (50 jpeg 128x128 q85, seed 11) | 577KB raw | zstd | **1.05x** |
| trained 32KB dict on repetitive text (12000 rows, seed 7) | — | 1.8KB saved | **1.7%** smaller warm |

Sources: `bun bench/mixed-corpus.ts`, `bun bench/photo-bench.ts`,
`bun bench/dict-bench.ts` (each with `--write-readme` for the README tables).

## perf (`bun bench/perf.ts`, mixed corpus 6000 rows seed 7)

| what | measured |
|---|---|
| seal throughput | **8.3MB/s** — 2518925B input sealed in 290ms into 3 warm chunks (246774B) |
| ship full | **211716B in 2 chunks** (default lanes; blob table chunk ships only with `includeBlobs`) |
| ship delta (600 new rows after full ship) | **1791B in 1 chunk** |
| ship delta vs full ratio | **0.008** (1791 / 211716) |
| find single-chunk latency | **7.62ms median** over 20 iters for `trx-00002000` (1 chunk fetched, 2 pruned) |

Method: seal once, ship full to an empty relay, append 600 rows (10%,
new seqs/ids), reseal, ship again to the same relay — the second ship
sends only the new chunk. Find times `findTrx` (read + crc verify +
decode + id scan) with `performance.now()`.

## flakes

Full-suite flakes are load contention, not regressions: kill-timing
(a kill landing before/after a write flushes) and port reuse under
load (p2p sockets rebinding while soak/concurrent/worker-safety
saturate the box) in one giant `bun test test/` run.

- `bun run test:stable` — everything except the timing-sensitive files.
- `bun run test:heavy` — only the timing-sensitive files
  (`test/soak.test.ts`, `test/concurrent.test.ts`,
  `test/worker-safety.test.ts`, `test/p2p.test.ts`), run on their own
  so they get the machine to themselves.

Rule: a failure that never reproduces in its scoped file
(`bun test test/<file>.test.ts`) is contention until proven otherwise —
re-run the single file before opening an issue.
