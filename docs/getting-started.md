# moltarc quickstart (5 minutes)

Seal a hot log into warm chunks, ship deltas to a relay, find one record back.

## Prerequisites

- `bun` on PATH (`bun --version` works).
- A hot input: either a SQLite `hot.db` or a JSONL WAL export (one object per line
  with `device_id,seq,ts,id,table,body`).

## 1. Make a hot log (30 seconds)

```bash
# Option A: run the canned example (1200 feed rows -> archive -> relay -> find)
bun examples/e2e.ts /tmp/moltarc-e2e

# Option B: hand-write one JSONL line
echo '{"device_id":"device-01","seq":1,"ts":1700000000000,"id":"trx-00000001","table":"reading","body":"FIELD READING plot=plot-1 temp=24C"}' > /tmp/hot.jsonl
```

The example writes the log, seals, ships, and finds one id back
(`examples/e2e.ts:46-65`).

## 2. Seal hot -> warm (1 minute)

```bash
bun bin/moltarc.ts seal /tmp/hot.jsonl /tmp/moltarc/archive
# SQLite input works the same:
# bun bin/moltarc.ts seal hot.db /tmp/moltarc/archive [--table <name>]
```

What happens: per-table batches pack to ~2MB compressed chunks (`warm/*.chk`),
and the per-device `sealed_upto_seq` watermark advances so re-seal is idempotent
(`docs/architecture.md` Hot, CLI shape `bin/moltarc.ts:38`).

## 3. Ship warm -> relay (1 minute)

```bash
bun bin/moltarc.ts ship /tmp/moltarc/archive /tmp/moltarc/relay
# Blobs stay behind by default; include them with:
# bun bin/moltarc.ts ship /tmp/moltarc/archive /tmp/moltarc/relay --blobs
```

Only chunk hashes missing on the relay are sent, resumable, text lane first
(`docs/architecture.md` Ship, CLI shape `bin/moltarc.ts:39`).

## 4. Find one record (30 seconds)

```bash
bun bin/moltarc.ts find /tmp/moltarc/archive trx-00000001
```

The manifest (min/max + bloom per chunk) prunes to 1 chunk fetch instead of
scanning the archive (`docs/architecture.md` Find, CLI shape `bin/moltarc.ts:40`).

## 5. Trust but verify (1 minute)

```bash
bun bin/moltarc.ts verify /tmp/moltarc/archive
bun bin/moltarc.ts status /tmp/moltarc/archive /tmp/moltarc/relay
# Old warm -> cold tar when you outgrow warm:
bun bin/moltarc.ts merge /tmp/moltarc/archive
```

`verify` checks per-chunk `crc32c + sha256` and quarantines at most one chunk
(`docs/contracts.md` Quarantine); `merge` packs warm chunks into `cold/*.tar`
(`docs/architecture.md` Cold); full command list in `docs/cli.md`.

## What good looks like

- `seal` prints rows sealed + chunk count (see `examples/e2e.ts:53`).
- `ship` prints chunks sent; a second `ship` with no new data sends nothing.
- `find` prints the chunk name and `fetched 1`-style single-chunk hit.
- Measured ratios for planning (seeded benches, `README.md` Honest SLA):
  repetitive text **34.5x**, mixed text **10.2x**, raw jpeg **~1.05x**
  (incompressible — ships as hash ref, lazy fetch).

## Next

- `docs/decisions.md` — why each default (chunk size, codec, lanes, …).
- `docs/architecture.md` — hot/warm/cold pipeline and component map.
- `docs/bench.md` — how the SLA numbers are measured.
