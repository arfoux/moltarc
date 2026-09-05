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

## Honest SLA

- Pure repetitive text log → 30-50x (5GB → ~100-150MB) achievable
- Mixed DB (free text + index bloat) → 8-15x
- Photo-heavy DB → 2-5x (JPEG is incompressible; blobs ship lazy, never in the mandatory archive)

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
