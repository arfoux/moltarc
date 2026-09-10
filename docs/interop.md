# interop (any append-only feed)

moltarc seals any append-only feed with no manual conversion step. Game
events, file versions, device telemetry, and entry-ledger rows all normalize
through the same aliases (`normRow`, `src/seal.ts:62-93`). Proof:
`test/interop.test.ts` (90-event `ledger.log` seals; one entry finds back).

## What seals directly

Any JSONL row carrying `device_id,seq,ts,id,table,body` — or one of the
aliases below. First-class shapes:

- game events: `{"device_id":"node-01","seq":3,"ts":1700000000000,"table":"events","body":"..."}`
- file versions: same shape with `"table":"versions"` (one row per version)
- device telemetry: same shape with `"table":"readings"`
- entry-ledger: raw entry/undo events with a `value` payload, no `table` key
  needed — the event kind becomes the table (`test/interop.test.ts:11-36`):

```json
{"device_id":"device-01","seq":3,"ts":1700000000000,"type":"entry","trx":"trx-00000003","value":55000,"actor":"agus"}
{"device_id":"device-01","seq":9,"ts":1700000000000,"event":"undo","ref":"trx-00000005","reason":"wrong-input"}
```

```bash
bun bin/moltarc.ts seal ledger.log /tmp/moltarc/archive
bun bin/moltarc.ts find /tmp/moltarc/archive trx-00000003
```

## Field aliases (`normRow`, `src/seal.ts:62-93`)

Alternative keys are equivalent; first present wins:

| Row field | Aliases |
|---|---|
| `seq` | `seq` (integer 1 … 99 999 999, else malformed) |
| `ts` | `ts`, `timestamp` (defaults to now) |
| kind (becomes `table` when no `table` key) | `type`, `event` |
| value | `value`, `total` |
| body | `body`, string `payload`, `msg`, `data`, `note`, `details`; empty body is composed from kind + `value=` + `actor=` + `ref=` + `reason=` + `item=` + `qty=` + `state=` + `hides=` + `shows=` |
| device | `device_id`, `device` (defaults to `dev0`) |
| id | `id`, `trxId`, `trx_id`, `trx`, `key`; fallback `table:device:seq` |
| table | `table`, else kind, else the seal `--table` / fallback |

So an `entry` event with `trx: trx-00000003` keeps id `trx-00000003` in table
`entry` with `value=55000` in the body; an `undo` with `ref` lands in table
`undo` with the referenced id in the body (`test/interop.test.ts:39-47`).
When `payload` is an object (raw fielog `ledger.log` lines), it is field
source, not body text: its `value`/`actor`/`ref`/`reason`/`item`/`qty`/
`state`/`hides`/`shows`/`event_id`/`reverses`/`note`/`details` backstop the
missing top-level keys (top-level wins), and `ref` also falls back to
top-level `event_id`/`reverses`.

## Related demos

- `bun examples/universal-demo.ts` — 50-row generic event feed, seal → ship →
  find one event, prints the shrink ratio (`examples/universal-demo.ts`).
- `bun examples/ledger-demo.ts` — 50-row entry-ledger feed (table `events`,
  file `ledger.jsonl`), seal → ship → find one entry, prints the shrink ratio
  (`examples/ledger-demo.ts`). The raw entry/undo shape (no `table` key,
  fields under `payload`) is covered by the interop proof above
  (`test/interop.test.ts`).
- `bun examples/e2e.ts` — 1200-row multi-device feed (sensors + operator
  activity across `device-01`/`device-02`), the multi-device watermark path
  (`examples/e2e.ts`).
