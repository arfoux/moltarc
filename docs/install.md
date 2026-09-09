# install

Get a working `moltarc` CLI. One runtime dependency (`bun`); everything else
is source plus one npm package for the foto preview path.

## Prerequisites

- `bun` on `PATH` (`bun --version` works). Ratios in this repo were measured
  with bun 1.4.0 on Windows x64 (`docs/bench.md`); any recent bun works.
- `git`, to clone the repo.
- Optional, native extension only: MinGW `gcc` + the SQLite amalgamation
  (fetched by `bun ext/fetch-sqlite.ts`, kept out of git). Skip this unless
  you touch `ext/`.

## Steps

```bash
git clone https://github.com/arfoux/moltarc.git
cd moltarc
bun install          # installs jpeg-js (foto thumb previews); thats the only dependency
bun bin/moltarc.ts help
```

`bun bin/moltarc.ts help` prints the full subcommand list (same lines as
`docs/cli.md`). No build step: bun runs `src/*.ts` directly. `bun run build`
(`tsc -p tsconfig.json`) is the typecheck, not a prerequisite for running.

## Verify the install

```bash
bun examples/e2e.ts /tmp/moltarc-e2e
# seal: ... rows -> ... chunk(s) ... / ship: sent ... / find: ... -> chunk ...
```

That script writes a 1200-row hot feed, seals, ships to a relay dir, and
finds one id back (`examples/e2e.ts`). If it prints `e2e ok`, seal/ship/find
all work on your machine.

## What gets installed where

- Nothing global. The CLI is `bin/moltarc.ts` (package `bin` maps `moltarc`
  to it for npm publishes; `package.json` `files` ships only
  `src`/`bin`/`README.md`/`CHANGELOG.md`/`LICENSE`).
- Archives live in plain directories you choose (`<outDir>` with
  `warm/` + `manifest.json`); the relay is another directory. No daemon,
  no port, no background service — except `p2p-sync`, which dials a peer URL
  you give it per run.

## Next

- `docs/getting-started.md` — the 5-minute seal → ship → find run.
- `docs/troubleshooting.md` — when a step above fails.
