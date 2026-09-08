# Security policy

moltarc is a small-team open-source project. This policy states what is
covered, how to report, and what to honestly expect back.

## Report a vulnerability

- Preferred: open a **private security advisory** on the
  [moltarc GitHub repo](https://github.com/arfoux/moltarc)
  (Security tab → Advisories). It stays non-public until fixed.
- Alternative: open a regular issue at
  `https://github.com/arfoux/moltarc/issues` **only** if the issue is not
  exploitable before a fix (e.g. a missing cap with no reachable sink).
  When in doubt, use the private advisory.
- Include: affected version/tag, the input or peer behavior that triggers
  it, and what you expected to happen (throw / quarantine / reject).

## Scope

In scope (things moltarc promises to get right):

- Archive decoders: chunk frames (`src/chunk.ts`, 16 MB decompressed cap),
  cold tar members (`src/cold.ts`, 32 MB / 50 000-member caps), bloom
  bitsets (`src/find.ts`, 1 MB fail-open cap), thumb inputs
  (`src/thumb.ts`, 32 MB + 8192 px caps). A crafted archive or relay must
  fail loud, never mis-decode.
- Path confinement: chunk/sha/owner/bundle names reject `/`, `\`, `..`
  (`src/guard.ts`); tar member names are validated before any write
  (`restore-from-cold`, `src/cold.ts`).
- Sync auth: P2P frames are HMAC-SHA256 verified before parse
  (`src/p2p.ts`); without `MOLTARC_PSK` the node is trusted-LAN-only by
  documented design, not by accident.
- Integrity: per-chunk `crc32c + sha256`, quarantine-instead-of-loss on
  corrupt data (`src/verify.ts`).

Out of scope (please still file them as normal bugs, not advisories):

- Benchmark ratios moving on your hardware (see `docs/bench.md`).
- Timing-sensitive test flakes under parallel load (see `docs/bench.md`
  "flakes": run `bun run test:stable` vs `bun run test:heavy`).
- The `ext/moltarc.dll` checked-in proof binary: local-only build artifact,
  never a distribution channel (`docs/compat.md`).

## Response

No guaranteed SLA: this is maintained by a small team on a best-effort
basis. Expect an acknowledgement within about a week; fixes land as versioned
tags with a `CHANGELOG.md` entry. Severe, trivially-exploitable decoder or
traversal bugs are prioritized over everything else.
