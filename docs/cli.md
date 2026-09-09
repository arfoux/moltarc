# CLI reference

Every line below is verified against `bin/moltarc.ts` usage lines (35-53)
and the dispatch (140-304). If the CLI and this page ever disagree, the CLI
is right — run `bun bin/moltarc.ts help`.

Global: `--verbose` anywhere in argv is silently stripped (filtered before
dispatch); it enables nothing today. `help` / `-h` / `--help` print the
usage list. Unknown commands print usage to stderr and exit 1.

## Write path

### `seal` — hot input → warm chunks

```
moltarc seal <hot.jsonl|hot.db> <outDir> [--table <name>]
```

Reads new rows since the per-device `sealed_upto_seq` watermark, packs them
into immutable `warm/*.chk` chunks (~2 MB target, 1–4 MB bounds), and advances
the watermark per flushed chunk. Accepts a JSONL WAL export (one object per
line) or a SQLite file (detected by the `SQLite format 3` magic; tables
`tx`/`log` via `bun:sqlite`). `--table` overrides the fallback table name
for rows that carry none. Prints rows sealed, chunk count, and the watermark;
extra lines report replaced (same key, new body wins), skipped (already
sealed), and malformed rows. Input over the 1 % malformed share aborts loud
(`MALFORMED_ABORT_PCT`, `src/seal.ts`). Refuses to start under 50 MB free
space (`checkReserve`). Second concurrent seal fails loud on `seal.lock`
instead of racing the watermark.

### `ship` — warm → relay, delta by hash

```
moltarc ship <outDir> <relayDir> [--blobs]
```

Sends only chunks whose sha256 the relay index lacks, resumable per chunk
Blob-family tables
(`*blob* | *photo* | *image* | *thumb*`) ship last and are skipped
unless `--blobs`; with `--blobs`, `photo/*.bin` sidecars go too (small ones
copied if missing, large ones resumable). `--blobs` is the only accepted
flag. Prints `shipped N chunk(s), skipped M, BB`.

### `p2p-sync` — warm ← peer over the wire

```
moltarc p2p-sync <peerUrl> <outDir> [--token <t>]
```

Pulls missing chunks from a live peer (`hello`/`want`-by-sha/`block`/`end`
with journal resume and idempotent atomic apply). `--token` authenticates
against the peer's `allowPeers` sha256 allowlist. Chunk bytes are
HMAC-SHA256 framed; signing key comes from `MOLTARC_PSK` (comma-separated
rotation list, primary first) or the trusted-LAN fallback when unset
(`src/p2p.ts`). Prints `synced / skipped / failed / bytes` plus one line per
received/failed chunk.

## Read path

### `find` — one row, one chunk

```
moltarc find <outDir> <id>
```

Prunes via manifest min/max + bloom (+ shard/sparse fast path), fetches a
single warm chunk, prints the row JSON then `chunk <file> fetched <n>`.
Searches **warm only** and throws when absent; cold needs the library-level
`findCold`. Quarantined chunks are skipped, never returned.

### `asof` — state as of a point in history

```
moltarc asof <outDir> <ts> [--seq <n>]
```

Folds chunk versions per id at timestamp `ts` (ms) or, with `--seq <n>`,
at sequence `n`. Latest row per id with seq/ts ≤ target wins; future chunks
prune without I/O. Prints rows JSON then a proof line (rows, target, chunks
consulted, pruned). Damage contract (`src/timetravel.ts`): corrupt bytes in
a kept chunk **throw** (fail-closed); absent chunk files are skipped with a
loud warning and counted in `proof.skippedMissing` (partial fold — check it
before treating rows as authoritative).

### `status` — archive meter

```
moltarc status <outDir> [relayDir]
```

Prints chunks, bytes, warm chunks/bytes, cold segments/chunks/bytes,
unacked count, and orphans with bytes. With `relayDir`, unacked compares
against the relay index; without it the meter still prints (ack state
unknown). Read-only.

## Integrity

### `verify` — full chunk walk

```
moltarc verify <outDir>
```

Re-hashes every chunk (`crc32c + sha256`), cross-checks manifest bindings,
checks the per-table seq chain. Hard chain breaks are fatal; forward seq
skips print as `GAP …` warnings only. Prints one line per chunk plus a
summary; exits 1 when not ok.

### `repair` — refetch bad chunks by hash

```
moltarc repair <outDir> <relayDir>
```

Re-runs verify, refetches each bad chunk's good bytes by manifest sha256
from the relay (`chunks/<file>`, index-mapped), re-scans the entry
(crc/bloom/minmax refilled — quarantined stubs carry none), then re-verifies.
Prints `REPAIRED` / `FAILED <file> (<error>)` lines plus the verify summary;
exits 1 when still not ok. Unrepairable chunks stay quarantined: exactly one
chunk of history lost (1/150 in a 150-chunk archive — illustrative size), never the archive.

### `check` — unacked escalation alert

```
moltarc check <outDir> <relayDir>
```

Read-only rollup over unacked growth, quarantine count, and disk pressure
(`src/alerts.ts`). Prints `alerts: <level>` with counts plus one `reason`
line per escalation. Exit codes: `ok` → 0, `warn` → 1, `critical` → 2.
Defaults: warn/critical at 5/20 unacked, 1/3 quarantined, 100 MB/50 MB free.
Throws (instead of reporting `ok`) when no readable manifest copy exists.

## Lifecycle (warm → cold → gone)

### `merge` — warm chunks → cold tar segment

```
moltarc merge <outDir>
```

Packs warm chunks (plus their dict members) into `cold/seg-*.tar` and records
the segment in the manifest. Prints `merged N chunk(s) -> cold/<seg> (BB)`
or `merge: nothing new to pack`. Refuses under 50 MB free space.

### `forget` — drop named chunks (acked only)

```
moltarc forget <outDir> <relayDir> <chunk> [chunk...]
```

Removes listed chunks from warm + manifest after verifying each is acked by
the relay; unacked names abort the whole call (atomic, no partial forget).
`<chunk>` is basename-checked (`assertChunkName`). Prints one `forgot` line
per chunk plus the reminder: bytes stay on disk until `gc --apply` and
`coldg --apply` run.

### `gc` — orphan sweep, dry-run by default

```
moltarc gc <outDir> [relayDir] [--apply] [--deep-photo]
```

Orphan = `warm/*.chk` with refcount 0 in the manifest. Default is dry-run
(lists, deletes nothing). `--apply` deletes, and **requires** `relayDir`:
only relay-acked orphans are removed (rule 7); without a relay dir every
orphan is retained fail-closed. `--deep-photo` additionally scans warm bodies
for `photo:sha256:…` refs, reports sidecars no chunk references as
`photo-orphan` (deleted on apply iff the relay acks the sha) and referenced
shas with no sidecar as `photoMissing`. Tmp/state litter (`*.tmp.*`,
`.p2p-state-*`) is reported on dry-run and collected on apply.

### `coldg` — cold prune + repack, dry-run by default

```
moltarc coldg <outDir> [--apply]
```

Prunes dead members from `cold/*.tar` (repack without them, manifest
rewrite, dual-copy atomic) and reports reclaimable bytes. Dry-run by
default; `--apply` performs the sweep after the 50 MB reserve check. Corrupt
segments are listed as `corrupt … (left on disk, needs repair)` and never
auto-deleted. `photo/` sidecars are census-counted here, never deleted
(`gc --deep-photo` owns photo deletes).

### `restore-from-cold` — cold segments → warm

```
moltarc restore-from-cold <outDir> [--apply]
```

Disaster drill for a warm dir lost to cold only. Dry-run (default) validates
every tar member name first (chunk gate + `dicts/dict-<8hex>.dict` shape) and
prints `dry-run: would restore N chunk(s) + M dict(s) from K segment(s)`.
`--apply` extracts members back to `warm/` + `dicts/`, rebuilds the manifest
(including the `cold` list), and clears the find caches. A hostile tar
aborts before touching disk.

## Upgrade

### `migrate` — old manifest → current (v1)

```
moltarc migrate <outDir> [--dry-run]
```

Forward-only: rescans warm chunks into a fresh v1 manifest and swaps it
atomically (backup to `manifest.pre-migrate.json` first). Chunk files are
never touched. `--dry-run` prints the plan without writing. New binaries
refuse to rewrite old manifests in place (7 write paths call
`assertMigrated()`), so encountering the guard error means: run `migrate`
once, then retry.
