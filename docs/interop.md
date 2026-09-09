# fielog interop

moltarc seals raw fielog sales logs with no manual conversion step. Proof:
`test/interop.test.ts` (90-event `ledger.log` seals; one receipt finds back).

## What seals directly

Raw sales events with `type`/`event` of `payment`/`undo` and an `amount`
payload (`test/interop.test.ts:11-36`):

```json
{"device_id":"device-01","seq":3,"ts":1700000000000,"type":"payment","trx":"trx-00000003","amount":55000,"actor":"agus"}
{"device_id":"device-01","seq":9,"ts":1700000000000,"event":"undo","ref":"trx-00000005","reason":"salah input"}
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
| amount | `amount`, `total` |
| body | `body`, `payload`, `msg`, `data`, `note`, `details`; empty body is composed from kind + `amount=` + `actor=` + `ref=` + `reason=` |
| device | `device_id`, `device` (defaults to `dev0`) |
| id | `id`, `trxId`, `trx_id`, `trx`, `key`; fallback `table:device:seq` |
| table | `table`, else kind, else the seal `--table` / fallback |

So a `payment` event with `trx: trx-00000003` keeps id `trx-00000003` in table
`payment` with `amount=55000` in the body; an `undo` with `ref` lands in table
`undo` with the referenced id in the body (`test/interop.test.ts:39-47`).

## Related demos

- `bun examples/sales-demo.ts` — 50 sales receipts, seal → ship →
  find one receipt, prints the shrink ratio (`examples/sales-demo.ts`).
- `bun examples/e2e.ts` — 1200-row field feed (paddy sensors + farmer
  activity across `fielog-01`/`fielog-02`), the multi-device watermark path
  (`examples/e2e.ts`).
