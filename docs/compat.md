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
  with a sane `chunks` array.

## cold segments

`cold/seg-*.tar` members are plain ustar over already-compressed chunks;
the tar layer has no version and needs none — compat lives in the chunk
and manifest layers above.
