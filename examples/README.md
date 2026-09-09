# examples

Runnable end-to-end demos for moltarc: write a hot JSONL feed, `seal` it into
warm chunks, `ship` the chunks to a relay dir, then `find` one transaction back.
The core accepts any append-only feed (`device_id,seq,ts,id,table,body`).
Below are sample usages.

## Demos

- `universal-demo.ts` — generic shop orders (50 rows, English).
  `bun examples/universal-demo.ts [--out <dir>]` / `bun run demo`
- `e2e.ts` — field-log feed (paddy sensors + farmer activity, 1200 rows).
  `bun examples/e2e.ts [--out <dir>]` / `bun run e2e`
- `sales-demo.ts` — shop receipts (50 rows).
  `bun examples/sales-demo.ts [--out <dir>]` / `bun run sales`
## Universal demo

`writeOrders(dir, rows)` writes `orders.jsonl` — one JSON object per line with
`device_id, seq, ts, id (trx-XXXXXXXX), table: sales, body`:

```text
GREEN MART 42 MARKET ST ORDER: no=1001 amount=15000 tender=cash clerk=alex THANK YOU FOR SHOPPING WITH US
```

`runUniversalDemo(baseDir, rows = 50)` then seals to `<baseDir>/archive`,
ships to `<baseDir>/relay`, finds the middle order by id, and prints the
shrink ratio (`inputBytes / warmBytes`).

Default output dir is `examples/universal-out/`.
