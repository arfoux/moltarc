# molt — shrink + ship + find

Tiered SQLite archive for UMKM-scale data: hot DB stays small and fast,
warm chunks compress schema-aware, cold archive ships once, query stays partial.

## Pipeline

```
[hot.db r/w SQLite] --seal--> [warm/*.zst 1-4MB immutable] --merge--> [cold/*.tar.zst] + manifest.json
```

CLI:

```
molt seal   # hot WAL -> warm chunks (columnar + dict + zstd)
molt ship   # send only missing chunk hashes, resumable
molt find <trx-id>  # fetch 1 chunk via manifest, not 100MB
```

## Honest SLA (measured, not planned)

- Repetitive tx text → **34.4x** (band 25-60x)
- Mixed text + free notes + blob refs → **10.2x** (band 6-12x)
- Photo blobs → excluded from the mandatory archive, lazy/on-demand (`blob:sha256:…` refs only)

Details in [Measured SLA](#measured-sla) below. Older micro-benchmark (5-template POS log, 3.45MB → 10.7KB = 323x)
is retired: too repetitive to plan from.

## Notes

- Codec: zstd (Node 22 built-in) with deflate fallback; `codec` byte in the 64B header keeps chunks
  self-describing, dict inline in the frame (`dict_id = fnv1a32(devices + body pool)`).
- Hot input auto-detects: `hot.db` SQLite (magic `SQLite format 3`, tables `tx`/`log` with
  `device_id,seq,ts,id,table,body` via `bun:sqlite`) or JSONL WAL export (one object per line).
  `sealed_upto_seq` watermark + `device_id:seq` dedupe make re-seal idempotent.
- Text-first ship lanes: `*blob* | *photo* | *image* | *thumb*` tables ship last and are skipped
  unless `includeBlobs: true`.

## Rules (non-negotiable)

1. Hot stays SQLite boring: no custom header. Warm chunk header 64B: `magic UMK1 | ver | codec | table | seq_min/max | ts_min/max | rows | crc32c | dict_id`.
2. Chunk 1-4MB compressed (default ~2MB): retry-cheap, OPFS-friendly, one ArrayBuffer.
3. Manifest atomic (`tmp + fsync + rename`), dual copy + rebuild from deterministic filenames.
4. Text vs blob split: archive ships text+hash+thumb; full photos lazy/on-demand.
5. Per-chunk `crc32c + sha256`; corrupt chunk quarantines 1/150 of history, never total-loss.
6. Codec self-describing (`codec_id + dict_id`, N-2 backward compat); dictionary inside archive.
7. Never delete unsealed/unacked data. `sealed_upto_seq` watermark + idempotent replay `(device_id, seq)`.

## Layout

- `src/seal.ts` — hot WAL -> warm columnar chunks (delta/RLE/dict + zstd)
- `src/manifest.ts` — atomic manifest, min/max + bloom, rebuild scan
- `src/ship.ts` — delta by hash, chunked resume, text-first lanes
- `src/find.ts` — prune + bloom + single-chunk fetch + sparse index
- `src/verify.ts` — hash verify, quarantine, repair-by-hash
- `test/` — 5GB→100MB on synthetic repetitive log, resume mid-ship, 1-corrupt-chunk survival
- `bench/mixed-corpus.ts` — deterministic 60/25/15 corpus, writes Measured SLA (`--write-readme`)
- `examples/e2e.ts` — fielog JSONL -> seal -> ship to relay dir -> find one trx

## Measured SLA

<!-- SLA-MEASURED-START -->
| corpus | input | warm archive | ratio |
|---|---|---|---|
| repetitive tx text (60% repetitive tx) | 1.64MB | 48.7KB | **34.4x** |
| mixed text+notes+refs (blob bytes excluded) | 2.40MB | 241.0KB | **10.2x** |
| photo blobs (3.23MB sidecar, lazy/on-demand) | excluded | excluded | n/a (incompressible) |

_Measured by `bun bench/mixed-corpus.ts --write-readme`; corpus deterministic (seeded). Blob bytes never enter the mandatory archive — only `blob:sha256:…` refs do._
<!-- SLA-MEASURED-END -->
