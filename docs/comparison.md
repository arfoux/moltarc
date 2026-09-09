# moltarc comparison matrix — 13 systems × 10 dimensions

**Selection-bias disclaimer.** This matrix was written by the moltarc authors to position
moltarc (content-addressed SQLite chunking + S3 tiers + optional cold archive) against
systems we studied while building it. Dimension choice, YES/NO thresholds, and wording
favor problems moltarc was designed for (offline-first edge SQLite, cheap S3 durability,
file-granular dedup restore). We are not neutral: we have not run every system at scale,
managed-service SLOs/pricing change without notice, and several competitors beat moltarc
decisively outside its niche — see "Where moltarc loses" below. Verify critical cells
against primary docs before deciding.

**Legend.** YES = first-class, documented, works out of the box. PARTIAL = works with a
footnote qualifier (extra component, tier, MVP state, or granularity mismatch) — every
PARTIAL cell carries a footnote marker. NO = absent or explicitly unsupported.

**Scope note.** "Cold" = archival object tier (Glacier / Deep Archive / equivalent) with
restore latency measured in minutes–hours, distinct from merely cheap Infrequent-Access
storage. "Snapshot as-of" = restore the dataset to an arbitrary timestamp/TXN, not just
"latest replica".

## Matrix

| System / Dim | (1) Cold archival tier | (2) Lazy on-demand fetch | (3) Snapshot as-of restore | (4) Multi-writer | (5) Offline-first local reads | (6) Delta / incremental sync | (7) S3-native backup | (8) SQL analytics / pushdown | (9) IAM / ACLs | (10) Self-hostable, no lock-in |
|---|---|---|---|---|---|---|---|---|---|---|
| **moltarc** | YES | YES | YES | NO | YES | YES | YES | PARTIAL [m1] | PARTIAL [m2] | YES |
| **Litestream** | PARTIAL [a] | PARTIAL [b] | YES | NO | YES | YES | YES | YES | PARTIAL [c] | YES |
| **LiteFS** | NO | PARTIAL [d] | PARTIAL [e] | PARTIAL [f] | YES | YES | PARTIAL [g] | YES | PARTIAL [c] | YES |
| **rqlite** | NO | NO | PARTIAL [h] | PARTIAL [i] | YES | PARTIAL [j] | PARTIAL [k] | PARTIAL [l] | PARTIAL [m] | YES |
| **Turso (libSQL)** | NO | PARTIAL [n] | YES | PARTIAL [o] | PARTIAL [p] | YES | YES | YES | YES | PARTIAL [q] |
| **Cloudflare D1** | NO | NO | PARTIAL [r] | PARTIAL [s] | NO [t] | PARTIAL [u] | PARTIAL [v] | PARTIAL [w] | YES | NO |
| **CR-SQLite** | NO | NO | PARTIAL [x] | YES | YES | YES | PARTIAL [y] | YES | PARTIAL [z] | YES |
| **CouchDB** | NO | NO | PARTIAL [aa] | YES | YES | PARTIAL [ab] | PARTIAL [ac] | PARTIAL [ad] | YES | YES |
| **restic** | NO | NO | PARTIAL [ae] | NO | YES | PARTIAL [af] | YES | NO | PARTIAL [c] | YES |
| **kopia** | NO | NO | PARTIAL [ae] | NO | YES | PARTIAL [af] | YES | NO | PARTIAL [c] | YES |
| **Borg** | NO | NO | PARTIAL [ae] | NO | YES | PARTIAL [af] | PARTIAL [ag] | NO | PARTIAL [c] | YES |
| **S3 tiers (+ Select)** | YES | NO | PARTIAL [ah] | NO | NO | PARTIAL [ai] | YES | PARTIAL [aj] | YES | NO |
| **Ditto** | NO | PARTIAL [ak] | PARTIAL [al] | YES | YES | PARTIAL [am] | PARTIAL [an] | PARTIAL [ao] | YES | PARTIAL [ap] |

## Footnotes (one per PARTIAL cell)

- [m1] moltarc SQL analytics is PARTIAL: full SQLite locally, but no columnar engine,
  no query pushdown into S3/cold; large scans must rehydrate first.
- [m2] moltarc IAM is PARTIAL: presigned-URL / bucket-policy based; no per-row ACLs,
  no managed identity provider.
- [a] Litestream cold is PARTIAL, not native: cold YES-equivalent only via a Glacier
  lifecycle policy on the replica bucket (S3 → Glacier transition + restore), not a
  Litestream-managed cold tier with rehydration.
- [b] Litestream VFS is PARTIAL page-lazy: lazy page fetch exists only through the
  experimental Litestream VFS (FUSE / `litestream vfs`), not the standard restore path,
  which downloads the full database.
- [c] Litestream / LiteFS / restic / kopia / Borg IAM is PARTIAL: they inherit
  S3/bucket IAM; none ships its own user/role/row-level access system.
- [d] LiteFS lazy fetch is PARTIAL: FUSE-based on-demand page load exists, but it is a
  cluster-coherent mount, not a cold-tier lazy fetch; cold objects are not paged in.
- [e] LiteFS snapshot as-of is PARTIAL: point-in-time restore depends on the external
  backup target (e.g. Litestream-exported base); LiteFS itself keeps live consensus
  state, not a timestamp-indexed snapshot log.
- [f] LiteFS multi-writer is PARTIAL: single primary with lease handover; all nodes are
  readable but only the primary accepts writes (no concurrent multi-primary writers).
- [g] LiteFS S3-native backup is PARTIAL: S3 export exists via the `litefs export` /
  Litestream bridge path, not a built-in continuous S3 backup loop.
- [h] rqlite snapshot as-of is PARTIAL: restores from a single snapshot file plus Raft
  log replay; no arbitrary-timestamp time travel.
- [i] rqlite multi-writer is PARTIAL: every write goes through the Raft leader (single
  serialization point); followers forward, they do not concurrently commit.
- [j] rqlite delta sync is PARTIAL: leader→follower replication is Raft log shipping,
  not content-defined delta sync usable over metered/cold links.
- [k] rqlite S3 backup is PARTIAL: auto-backup to S3 exists (`-auto-backup` / S3 store)
  on an interval, but it uploads whole snapshots rather than chunk-delta uploads.
- [l] rqlite analytics is PARTIAL: plain SQLite query surface; no pushdown, no columnar
  path, leader-only strong reads for freshness.
- [m] rqlite IAM is PARTIAL: basic-auth + TLS level only; no roles, per-table ACLs, or
  cloud IAM integration.
- [n] Turso lazy fetch is PARTIAL: lazy page loads over the network exist (embedded
  replica pulls missing pages on demand), but pages come from the hot Turso store, not
  from a cold archival tier.
- [o] Turso multi-writer is PARTIAL: MVCC writers are allowed but serialize through a
  single primary/database URL — concurrent writers get MVCC conflict errors, not
  multi-primary commits.
- [p] Turso offline-first is PARTIAL: embedded replicas serve local reads, but the
  primary is authoritative and the control plane is hosted; prolonged offline writes
  conflict on reconnect.
- [q] Turso self-host is PARTIAL: libSQL server is open source and self-hostable, but
  the managed sync/hosting tiers are vendor-operated.
- [r] D1 as-of restore is PARTIAL: time-travel bookmarks cover a short retention window
  (docs state ~30 days, varies), not indefinite archival snapshots.
- [s] D1 multi-writer is PARTIAL: single-primary-per-database execution; concurrent
  writers serialize, no multi-primary.
- [t] D1 offline is scored NO (no footnote needed): D1 has no offline story — Workers-bound,
  no local replica; a disconnected client cannot read or write.
- [u] D1 delta sync is PARTIAL: read replication exists inside Cloudflare's fabric, not a
  client-visible incremental delta protocol.
- [v] D1 S3 backup is PARTIAL: export-to-R2/S3 is a manual/scheduled export, not a
  continuous native backup stream.
- [w] D1 analytics is PARTIAL: SQLite-compatible queries with strict size/time limits;
  no OLAP pushdown or cross-database analytics engine.
- [x] CR-SQLite as-of restore is PARTIAL: version vectors + op log allow causal replay,
  but there is no built-in timestamp-indexed snapshot store.
- [y] CR-SQLite S3 backup is PARTIAL: persistence is "your SQLite file"; S3 durability
  requires an external shipper (Litestream, moltarc-style chunker, cron).
- [z] CR-SQLite IAM is PARTIAL: no auth layer of its own; inherits whatever wraps the
  database file/connection.
- [aa] CouchDB as-of restore is PARTIAL: `_changes` + per-rev history allow replay
  within retention, but there is no first-class "restore DB as of T" snapshot index.
- [ab] CouchDB delta is PARTIAL: replication is delta-based (only changed docs + new
  revisions transfer), but large attachments re-transfer in full in the MVP path —
  attachment-delta/dedup is not guaranteed.
- [ac] CouchDB S3 backup is PARTIAL: backup goes through replication or third-party
  snapshot tools; no native S3 backup target.
- [ad] CouchDB analytics is PARTIAL: Mango/map-reduce views cover document queries;
  no SQL engine or columnar analytics.
- [ae] restic / kopia / Borg snapshot as-of is PARTIAL: file-granular snapshots restore
  any snapshot's view of files, but that is a filesystem as-of — not a transactional
  database point-in-time (no page-level TXN replay inside a live SQLite file unless the
  DB was quiesced/dumped first).
- [af] restic / kopia / Borg delta is PARTIAL: content-defined chunk dedup means only
  changed blobs upload (incremental at the file-chunk layer), but there is no
  page-level database delta protocol.
- [ag] Borg S3-native is PARTIAL: no native S3 backend; S3 works only via rclone-style
  shims, unlike restic/kopia first-class S3.
- [ah] S3 tiers as-of is PARTIAL: Versioning + Object Lock give per-object history, not
  a transactional dataset snapshot; consistent as-of requires external coordination.
- [ai] S3 delta is PARTIAL: multipart/byte-range and replication transfer bytes, but S3
  itself computes no dataset delta — the client must diff.
- [aj] S3 Select is PARTIAL: S3 Select pushes down simple CSV/JSON/Parquet filtering,
  but with strict limits (no joins, no indexes, truncated SQL dialect) — not a query
  engine.
- [ak] Ditto lazy fetch is PARTIAL: small-object sync pulls on demand, but large
  attachments use explicit fetch handlers rather than transparent page-lazy reads.
- [al] Ditto as-of is PARTIAL: CRDT version history allows causal replay, not an
  indexed arbitrary-timestamp restore.
- [am] Ditto delta is PARTIAL: version-vector delta sync — only causally-new mutations
  transfer — but at document/field granularity, not SQLite page granularity.
- [an] Ditto S3 backup is PARTIAL: durability goes through Ditto Cloud or
  self-built connectors; no native S3 backup target.
- [ao] Ditto analytics is PARTIAL: local queries plus limited cloud queries; no
  SQL-analytics/pushdown story comparable to Turso/D1.
- [ap] Ditto self-host is PARTIAL: SDKs embed locally, but sync requires the Ditto
  Cloud control plane (or enterprise relay), so not fully self-hostable.

## Where moltarc loses (honest)

- **Multi-writer.** moltarc is single-writer (plus last-writer-wins or manual merge on
  conflict). rqlite, CR-SQLite, CouchDB, and Ditto all accept concurrent writers with a
  real conflict story; moltarc has none.
- **SLO / managed durability.** Turso, D1, S3, and Ditto Cloud ship multi-nine SLOs,
  on-call teams, and status pages. moltarc is self-operated code over your bucket —
  its uptime is your uptime.
- **Analytics.** Turso/D1 answer SQL without rehydrating the world; S3 Select and
  Parquet tooling query cold data in place. moltarc must restore chunks to a local
  SQLite file before any query runs.
- **IAM.** D1/Turso/S3/CouchDB/Ditto have users, roles, tokens, and audit paths.
  moltarc has bucket policies and presigned URLs — nothing row-level, nothing auditable
  per user.
- **Lifecycle.** S3 Lifecycle, restic forget policies, and kopia retention rules are
  declarative and battle-tested. moltarc GC/cold-transition is newer, hand-rolled, and
  easier to misconfigure into data loss or cost blowups.
- **Search.** CouchDB (Mango/Lucene), Ditto (local queries), and any Parquet+engine
  stack offer indexing/full-text paths. moltarc offers SQLite indexes post-restore only;
  there is no cold-index or server-side search.
- **Conflict-free replication (CRR).** CR-SQLite/CouchDB/Ditto converge concurrent
  offline edits by construction. moltarc replicates snapshots, so concurrent offline
  branches need external reconciliation.
- **Observability.** LiteFS metrics, Turso/D1 dashboards, restic/kopia check commands,
  and S3 Inventory/CloudTrail exceed moltarc's log-and-hook level telemetry (Prometheus
  export exists but is minimal; no hosted dashboard, no anomaly detection).
