# contracts and limits

The numbers moltarc refuses to negotiate. Each entry names the constant and
the file that enforces it, so you can check rather than trust.

## Sizes

| Contract | Value | Enforced in |
|---|---|---|
| Warm chunk target / floor / ceiling | ~2 MB / 1 MB / 4 MB (`TARGET_BYTES`, `MIN_BYTES`, `MAX_BYTES`) | `src/seal.ts` |
| Photo gate: base64 body decoding past this seals as sidecar, not inline | 256 KB (`PHOTO_INLINE_LIMIT_BYTES`) | `src/seal.ts` |
| Decompressed frame cap (bomb frames fail loud) | 16 MB (`DECOMPRESS_MAX_BYTES`) | `src/chunk.ts` |
| Tar member / member-count caps | 32 MB / 50 000 (`TAR_MEMBER_MAX_BYTES`, `TAR_MAX_MEMBERS`) | `src/cold.ts` |
| Bloom bitset probe cap (oversize → fail-open fetch) | 1 MB (`BLOOM_MAX_BYTES`) | `src/find.ts` |
| Legacy bloom geometry | 2048 bits, 3 hashes (`BLOOM_BITS`); newer chunks scale to ≥ rows × 10 bits | `src/manifest.ts`, `src/find.ts` |
| Shard pointer budget inside root manifest | 2048 bytes (`MAX_SHARD_POINTER_BYTES`) | `src/manifest.ts` |
| Per-table trained dict cap / training window | 32 KB / first 10 000 rows (`DICT_MAX_BYTES`, `DICT_TRAIN_ROWS`) | `src/dict.ts` |
| Thumb: preview side / quality / input / dimensions | 32 px / q70 / 32 MB / 8192 px (`THUMB_MAX_SIDE`, `THUMB_QUALITY`, `THUMB_INPUT_MAX_BYTES`, `THUMB_MAX_DIM`) | `src/thumb.ts` |
| Disk reserve: seal/merge/sweepCold-apply refuse below this | 50 MB (`RESERVE_BYTES`, `checkReserve`) | `src/gc.ts` |
| Malformed-row abort share | 1 % (`MALFORMED_ABORT_PCT`) | `src/seal.ts` |
| Sequence identity range (8-digit chunk filenames) | 1 … 99 999 999 (`SEQ_MAX`) | `src/seal.ts` |

## Photo gate (rule 4)

A base64 body whose decoded bytes exceed 256 KB never seals inline: raw bytes
go to `photo/<sha256>.bin` with a `photo/thumb-<sha>.jpg` preview plus a
`.json` hash-link, and the chunk keeps only the ref
`photo:sha256:<64hex>:size=<n>` (`quarantinePhotoBody`, `src/seal.ts`; thumb
layout `src/thumb.ts`). Strict re-encode check keeps large prose from
matching. Photo bytes are excluded from the mandatory archive (hash refs
only, lazy fetch — raw JPEG compresses ~1.05x, `README.md` Photo SLA).
`ship` sends sidecars only with `--blobs`; `gc --deep-photo` sweeps
unreferenced sidecars (relay-acked only) and reports referenced shas with no
`.bin` as `photoMissing`.

## Quarantine (rule 5)

Per-chunk `crc32c + sha256`. A corrupt chunk is parked in `quarantine/` and
flagged on its manifest entry — find skips it, ship never sends it, history
survives minus one chunk (`quarantine`, `repairByHash`, `src/verify.ts`).
Repair refetches good bytes by manifest sha256 from the relay and refills
crc/bloom/minmax (stubs carry none). Corrupt *cold* segments are reported and
left on disk (`coldg`), never auto-deleted. Timetravel is fail-closed on
corrupt bytes (throws) and explicit-partial on missing files
(`proof.skippedMissing`, `src/timetravel.ts`).

## Never lose data (rule 7)

Seal never deletes input; ship never deletes source; CAS puts never rewrite
identical bytes. `forget`/`gc` delete only relay-acked chunks — `forget`
aborts atomically on any unacked name, `gc --apply` requires `relayDir` and
retains every orphan otherwise (fail-closed). `forget` prints the standing
reminder: bytes remain until `gc --apply` + `coldg --apply`.

## Identity, dedupe, order

- Hot rows coerce `seq`/`ts` to integers (empty string never becomes 0;
  floats rejected). Fallback id is namespaced `table:device:seq` so shared
  logs never collide across tables (`normRow`, `src/seal.ts`).
- Re-seal is idempotent: per-device `sealed_upto_seq` watermark plus
  keep-last dedupe on (table, device, seq) — a second seal skips sealed rows,
  a concurrent second seal fails loud on `seal.lock`.
- Chunk filenames carry the seq in exactly 8 digits; out-of-range seqs are
  malformed at the gate.

## Traversal and shape gates

`assertChunkName` rejects `/`, `\`, `..`, and anything not matching
`^\w[\w.-]*\.chk$`; `assertSha` requires 64 lowercase hex (`src/guard.ts`).
Tar member names are validated before any `restore-from-cold` write (chunk
gate, dict members exactly `dicts/dict-<8hex>.dict`); a hostile tar aborts,
never writes. Bundle member names get the same treatment (`src/bundle.ts`).
P2P applies the same gates to peer-supplied names before touching disk.

## Codec and manifest promises (N-2)

Header is 64 B: `magic UMK1 | ver | codec | table | seq_min/max | ts_min/max
| rows | crc32c | dict_id` (`src/chunk.ts`). Writers emit zstd only; readers
decode `NONE`/`ZSTD`/`DEFLATE` and hard-error on unknown codec ids. Manifest
writes are tmp + fsync + rename, dual copy (`manifest.json` +
`manifest.bak.json`) with a seq+crc envelope; load picks the best crc-valid
copy, shard/sparse sidecars fall back to root on any skew. Full surface is
pinned in `docs/compat.md`; rationale in `docs/decisions.md`.

## Sync auth

P2P frames are `HMAC-SHA256(json) + '.' + json`, verified on raw bytes
*before* parse against every listed key (`src/p2p.ts`). Keys come from
`MOLTARC_PSK` (comma-separated rotation list, primary first) or the per-call
`psk` option. No PSK means documented trusted-LAN-only fallback — anyone on
the network can sync. The legacy `token` guards hello only; `allowPeers`
holds `sha256(token)` strings and an empty list serves anyone.
