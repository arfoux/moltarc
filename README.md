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

- Repetitive tx text, 60% tx slice of `bun bench/mixed-corpus.ts` (6000 rows, seed 7) → **34.5x**
- Mixed text+notes+refs, full mixed corpus of `bun bench/mixed-corpus.ts` (6000 rows, seed 7, blob bytes excluded) → **10.2x**
- Real jpeg bytes, raw zstd over the 50 real jpeg of `bun bench/photo-bench.ts` (128x128 blurred noise, q85, 600 text rows, seed 11) → **1.05x** (details in [Photo SLA](#photo-sla))
- Trained 32KB dict on repetitive text, `bun bench/dict-bench.ts` (12000 rows, seed 7, same corpus both sides) → **1.7%** smaller warm (details in [Dict SLA](#dict-sla))

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
- `src/cold.ts` — warm to cold tar merge plus prune sweep (repack without dead members, manifest rewrite)
- `src/ship.ts` — delta by hash, chunked resume, text-first lanes
- `src/find.ts` — prune + bloom + single-chunk fetch + sparse index
- `src/dict.ts` — per-table 32KB zstd dicts, trained when the sample compresses 4x+
- `bin/molt.ts` — CLI: `seal|ship|find|status|gc|merge|forget|coldg` over archive dirs (`bun bin/molt.ts …`)
- `bench/photo-bench.ts` — 50 real noise JPEGs sealed beside text, writes Photo SLA
- `bench/dict-bench.ts` — same corpus dict off vs on, writes Dict SLA
- interop: fielog `kasir.log` (`type` bayar / `event` undo + `nominal`) seals with no manual conversion (`test/interop.test.ts`)

## Measured SLA

<!-- SLA-MEASURED-START -->
| corpus | input | warm archive | ratio |
|---|---|---|---|
| repetitive tx text (60% repetitive tx) | 1.64MB | 48.6KB | **34.5x** |
| mixed text+notes+refs (blob bytes excluded) | 2.40MB | 240.9KB | **10.2x** |
| photo blobs (3.23MB sidecar, lazy/on-demand) | excluded | excluded | n/a (incompressible) |

_Measured by `bun bench/mixed-corpus.ts --write-readme`; corpus deterministic (seeded). Blob bytes never enter the mandatory archive — only `blob:sha256:…` refs do._
<!-- SLA-MEASURED-END -->

## Photo SLA

<!-- PHOTO-MEASURED-START -->
| bytes | input | warm archive | ratio |
|---|---|---|---|
| 50 real jpeg (128x128 blurred noise, q85, 577KB raw) sealed as base64 lines | base64 in jsonl | per-table chunks | **1.41x** |
| same jpeg bytes, raw zstd (the foto claim) | 577KB raw | zstd | **1.05x, inside 1.0-1.2x** |
| tx text beside the photos | text jsonl | text chunks + dict | **26.8x** |

_Measured by `bun bench/photo-bench.ts --write-readme`; deterministic (seeded). The base64 line ratio rides above raw because of the text envelope — raw jpeg bytes sit at ~1.05x, which is why photo bytes never enter the mandatory archive (hash refs only, lazy fetch)._
<!-- PHOTO-MEASURED-END -->

## Dict SLA

<!-- DICT-MEASURED-START -->
| repetitive text, dict off vs on | warm archive | ratio |
|---|---|---|
| plain (no trained dict) | 108.6KB | **30.5x** |
| with 32KB per-table dict | 106.8KB | **31.1x** |
| saving | 1.8KB (1.7%) | — |

_Measured by `bun bench/dict-bench.ts --write-readme`; same corpus both sides, only the dictionary differs. Columnar delta/RLE/inline-dict already captures most repetition — the trained dict takes what is left._
<!-- DICT-MEASURED-END -->
