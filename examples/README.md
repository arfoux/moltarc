# examples

Runnable end-to-end demos for moltarc: write a hot JSONL feed, `seal` it into
warm chunks, `ship` the chunks to a relay dir, then `find` one event back.
The core accepts any append-only feed (`device_id,seq,ts,id,table,body`):
game events, file versions, device telemetry, and entry-ledger rows all seal
the same way. Below are sample usages.

## Demos

- `universal-demo.ts` — 50-row generic event feed.
  `bun examples/universal-demo.ts [--out <dir>]` / `bun run demo`
- `e2e.ts` — 1200-row multi-device feed.
  `bun examples/e2e.ts [--out <dir>]` / `bun run e2e`
- `ledger-demo.ts` — 50-row entry-ledger feed (one domain example).
  `bun examples/ledger-demo.ts [--out <dir>]` / `bun run ledger`
- `dashboard.ts` — timetravel polling demo over a 300-row event feed.
  `bun examples/dashboard.ts [--out <dir>]`

## Universal demo

`writeEntries(dir, rows)` writes `entries.jsonl` — one JSON object per line with
`device_id, seq, ts, id, table: events`, and a neutral event `body`
(`no=`, `value=`, `mode=`, `actor=` fields — neutral event vocabulary).

`runUniversalDemo(baseDir, rows = 50)` then seals to `<baseDir>/archive`,
ships to `<baseDir>/relay`, finds the middle event by id, and prints the
shrink ratio (`inputBytes / warmBytes`).

Default output dir is `examples/universal-out/`.
