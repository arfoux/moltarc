# Contributing to moltarc

Small repo, few rules, all of them load-bearing. Follow this file and CI
stays green.

## Setup

```bash
git clone https://github.com/arfoux/moltarc.git
cd moltarc
bun install          # only dependency: jpeg-js (photo previews)
bun bin/moltarc.ts help
```

Requires `bun` on `PATH` (CI pins bun 1.4.0, `.github/workflows/ci.yml`).
No build step: bun runs `src/*.ts` directly.

## Tests

```bash
bun test test/<area>.test.ts   # scoped: the file for the area you touched
bun run test:stable            # everything except timing-sensitive files
bun run test:heavy             # soak/concurrent/worker-safety/p2p — needs the machine to itself
bun test ext/                  # native-extension reference tests
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # typecheck (CI runs this)
```

Rules:

- Touch one area → run its scoped file first. A failure that reproduces only
  in the full-suite run is load contention until proven otherwise
  (`docs/bench.md` "flakes"); re-run the single file before opening an issue.
- No new test for the sake of coverage. A test earns its place only where a
  plausible bug would fail it (behavior, boundaries, real errors — never
  wiring, forwarding, or source-text assertions).
- Existing tests that pin wording or incidental behavior instead of a
  contract should be deleted, not re-pinned.

## Benchmarks and README numbers

SLA ratios in `README.md` are generated, never hand-written: each bench
rewrites its own marker section from `bench/measured.json`
(`bun bench/mixed-corpus.ts --write-readme`, `photo-bench.ts`,
`dict-bench.ts`; timings via `bun bench/perf.ts`). `test/readme.test.ts`
fails on any hand-edited ratio. If your change moves a ratio, re-run the
bench and commit the regenerated table + `measured.json`.

## Docs

Evidence-first: every behavior claim must be grounded in `src/`, `bin/`, or
`ext/`. Verify every CLI flag against `bin/moltarc.ts` usage lines; never
invent APIs. One page per concern (`docs/`); `README.md` is the door + index,
not a second copy. Docs lead with the universal pipeline (game events, file
versions, device telemetry first; entry-ledger as one domain among many) and
keep example captions neutral. No dead links: every relative link must
resolve to a file that exists in git.

## Commit style and PR flow

- No enforced message convention; the history mixes English/Indonesian.
  Keep the subject short, imperative, user-visible ("add …", "fix …",
  "harden …"). Test-only hardening with no behavior change says so in the
  message — `CHANGELOG.md` marks those entries the same way.
- One concern per commit; docs and code for the same change go together.
- Push or open a PR against `main`: CI runs the typecheck +
  `bun run test:stable` + `bun test ext/` on every push and PR
  (`.github/workflows/ci.yml`). The heavy suite runs nightly, not on PRs
  (`.github/workflows/heavy.yml`).
- `CHANGELOG.md` entries are per tag, user-visible changes only, sourced
  from `git log`. Add an `Unreleased` section at the top while you work;
  maintainers fold it into the version section at release time.
