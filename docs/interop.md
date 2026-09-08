# fielog interop

moltarc seals raw fielog cashier logs with no manual conversion step. Proof:
`test/interop.test.ts` (90-event `kasir.log` seals; one struk finds back).

## What seals directly

Raw cashier events with `type`/`event` of `bayar`/`undo` and a `nominal`
payload (`test/interop.test.ts:11-36`):

```json
{"device_id":"kasir-01","seq":3,"ts":1700000000000,"type":"bayar","trx":"trx-00000003","nominal":55000,"kasir":"agus"}
{"device_id":"kasir-01","seq":9,"ts":1700000000000,"event":"undo","ref":"trx-00000005","alasan":"salah input"}
```

```bash
bun bin/moltarc.ts seal kasir.log /tmp/moltarc/archive
bun bin/moltarc.ts find /tmp/moltarc/archive trx-00000003
```

## Field aliases (`normRow`, `src/seal.ts:62-93`)

Indonesian and English keys are equivalent; first present wins:

| Row field | Aliases |
|---|---|
| `seq` | `seq`, `no`, `nomor` (integer 1 … 99 999 999, else malformed) |
| `ts` | `ts`, `timestamp`, `waktu` (defaults to now) |
| kind (becomes `table` when no `table` key) | `type`, `event`, `jenis` |
| amount | `nominal`, `amount`, `total` |
| body | `body`, `payload`, `msg`, `data`, `catatan`, `note`, `keterangan`; empty body is composed from kind + `nominal=` + `kasir=` + `ref=` + `alasan=` |
| device | `device_id`, `device`, `kasir_id` (defaults to `dev0`) |
| id | `id`, `trxId`, `trx_id`, `trx`, `key`; fallback `table:device:seq` |
| table | `table`, else kind, else the seal `--table` / fallback |

So a `bayar` event with `trx: trx-00000003` keeps id `trx-00000003` in table
`bayar` with `nominal=55000` in the body; an `undo` with `ref` lands in table
`undo` with the referenced id in the body (`test/interop.test.ts:39-47`).

## Related demos

- `bun examples/kasir-demo.ts` — 50 Indonesian struk kasir, seal → ship →
  find one struk, prints the shrink ratio (`examples/kasir-demo.ts`).
- `bun examples/e2e.ts` — 1200-row field feed (paddy sensors + farmer
  activity across `fielog-01`/`fielog-02`), the multi-device watermark path
  (`examples/e2e.ts`).
