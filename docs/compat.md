# archive compat

Rule: a reader MUST open any archive sealed by the current major and the
two previous codec generations (N-2 codec rule). Writers emit only the
current default (zstd); old codecs are decode-only, never re-emitted.

## what is pinned

- Magic `UMK1` is pinned. A non-`UMK1` chunk is rejected, not sniffed.
- Header `ver` is read but NOT gated: ver 0 chunks (pre-`VERSION = 1`)
  decode identically. A future ver gate MUST keep accepting back to N-2.
- `reserved` u32 (bytes 60-63) is ignored on read, zero on write.
- Frame `v` is read but NOT gated; unknown JSON fields in the frame are
  ignored — only the known columns (`ids`, `devI`, `pool`, `runs`,
  `dev`, `seqB`/`seqD`, `tsB`/`tsD`) are decoded.

## N-2 codec window

Supported today: `CODEC_NONE` (0), `CODEC_ZSTD` (1), `CODEC_DEFLATE` (2).
`decompressFrame` decodes all three; an unknown codec id is a hard error
(`unsupported codec N (N-2 compat: upgrade moltarc)`) — never silent
mis-decode. Dropping a codec id requires a major bump plus a migration
note here. Proof: `test/compat-v05.test.ts` hand-builds ver-0 deflate
chunks and asserts current `find`/`verify` read them.

## manifest tolerance

- Unknown fields are ignored (`sealedBy`, future keys — `JSON.parse`
  reads only known entries). Proof: the v0.5 fixture carries
  `sealedBy: 'molt-0.5'` per entry and loads clean.
- Missing optional fields get safe defaults: absent `cold` becomes `[]`;
  absent `minKey`/`maxKey` disables range prune (fetch, don't skip);
  absent `bloom` disables bloom prune. Old manifests therefore read
  slower (no pruning) but never miss rows.
- `verifyFull` validates entries only on `file` + `sha256` + `crc32c`,
  so entries predating `dictId`/`codec`/`bloom` still verify.
- `version` is informational: `loadManifest` accepts any numeric version
  with a valid `chunks` array.

## shard pointers (additive month list)

Root `manifest.json` keeps the full `chunks[]`; `shards`/`pointers`
(per-month `ShardPointer` month list) are additive only. Shard sidecars
`manifest-YYYY-MM.json` plus `sparse.json` are best-effort: readers fall
back to root `chunks[]` on missing sidecars, seq skew, or crc mismatch,
so old readers work untouched. Proof: `src/find.ts` shard fast path
returns null to the root scan on any skew.

## p2p token / allowlist

P2P auth is opt-in PSK: `allowPeers` holds `sha256(token)` strings and an
empty list serves anyone (LAN default). A non-empty list rejects
token-less peers and wrong tokens (`not allowed`), never downgrading to
open. Tokens travel only in `hello`; chunk bytes are unchanged.

## decompress transient (accepted bound, not a bug)

`decompressFrame` allocates the full frame first, then `checkFrameCap`
enforces 16mb. accepted because: an attacker needs chunk-write access
already (cheaper DoS exists at that point), aggregate caps bound fan-out
(p2p session, tar member count/size), and streaming inflate would rewrite
every decode caller to save a transient allocation that is already bounded.
re-litigate only with a reachable fan-out sink, not theory.
## native extension binary (not a compat surface)

`ext/moltarc.dll` (Windows) / `moltarc.so` (Linux) are local-only build
artifacts, never committed. They stay git-ignored (`ext/*.dll`, `ext/*.so`,
`ext/amalg/` in `.gitignore`; do not un-ignore them) because a built binary
is non-portable by construction:

- Baked-in bridge path: the build compiles
  `-DMOLTARC_TS="ext/moltarc.ts"` into the subprocess hook
  (`ext/moltarc_hook.c`), so the dll shells out to `bun ext/moltarc.ts`
  from the checkout root. Run SQL from the checkout root (or rebuild with
  your own path); moving the dll without its checkout + bun breaks it.
- Runtime dependency: every SQL call shells out to `bun ext/moltarc.ts`
  (`MOLTARC_BUN`, default `bun` on `PATH`); moving the dll without its
  checkout + bun breaks it.

Rebuild per machine from the checkout root (MinGW gcc 14.2, sqlite
amalgamation headers in `ext/amalg/`, kept out of git the same way):

```
gcc -shared -O2 -I ext/amalg/sqlite-amalgamation-3530400 -DMOLTARC_TS="ext/moltarc.ts" ext/moltarc.c ext/moltarc_hook.c -o ext/moltarc.dll
```

Proof after rebuilding: `bun test ext/moltarc-dll.test.ts` loads the local
dll via `bun:sqlite` and runs seal -> find -> miss==NULL. The chunk/manifest
compat promises above are unaffected: the extension holds zero format code
and reads through `src/seal.ts` + `src/find.ts` either way.
