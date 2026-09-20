# Automated performance and resilience experiments

The repository includes repeatable, local-only experiment harnesses. They exercise the real `KnowledgerService`, `LocalLedger`, `PrivateStore`, snapshot code, and HTTP server paths. They never connect to the Fabric network, use port 4317, or modify an existing runtime directory.

## Performance smoke

```sh
node tools/performance-smoke.ts \
  --documents 8 --samples 3 --body-bytes 1024 \
  --out "$PWD/.artifacts/performance-smoke.json"
```

The default dataset is intentionally small for CI. Use a separate disposable `--data` directory and `--documents 1000` or more for a larger local measurement. `--documents` is bounded at 100,000, `--samples` at 1,000, and `--body-bytes` at 256 KiB. The harness creates deterministic synthetic titles, document IDs, and body markers; it reports no document body.

The run publishes every synthetic document through the private draft, preview, and publish service path. It then measures repeated search and overview reads, closes and reopens the SQLite runtime to measure journal replay, and checks the database footprint. Every result includes p50, p95, and maximum elapsed time for each sampled operation, along with the requested dataset and runtime version.

Browse reads now traverse **all pages of compact summaries** (50 per page). The result marks this as
`dataset.read_workload: all_pages_summary`; these timings are not equivalent to the earlier single unbounded
response containing every body and history. Functional counts still cover the complete dataset before and after replay.

The [verified browse index](26-BROWSE-INDEX.md) records a like-for-like comparison of this paginated workload.
The first exact substring search still reads candidate bodies; subsequent cursor pages reuse bounded digest-ID results.
Run comparative benchmarks sequentially without the test suite/browser running at the same time. Operation-count
regressions in `test/api/browse-index.test.ts` check that ordinary pages no longer materialize the whole corpus.

## Revision history growth

```sh
npm run test:history-performance
```

This fixed, isolated workload publishes 200 revisions of one slot with 26-byte synthetic bodies.
At 10/50/100/200 revisions it measures five overview calls, serialized overview/history-page sizes,
the complete history count, and exact-body retrieval. History pages contain at most20 summaries.
It removes only its own temporary directory and reports JSON to stdout. It measures local behavior, not a Fabric SLA.

## Resilience smoke

```sh
node tools/resilience-smoke.ts \
  --out "$PWD/.artifacts/resilience-smoke.json"
```

The harness starts a separate Node worker against a new local runtime, commits a synthetic publication, force terminates the worker, and reopens the databases. It retries the same command and requires the same checkpoint without a second journal event. It also performs an offline runtime snapshot and restore into a new directory, then compares recovered state. A separate in-memory peer fixture is used only to make the HTTP API return strict 503 responses while unavailable; recovery must return 200 without changing the fixture event count.

Both harnesses clean up their automatically-created `.data` directory. Supplying `--data` or `--root` keeps the caller-owned disposable directory for inspection; an existing nonempty directory is rejected. CLI paths can be relative to the current directory. `--out` writes a mode-0600 JSON artifact under a caller-selected path. Errors go to generic stderr and do not include bodies, cookies, credentials, or filesystem contents.

## Backup/restore rehearsal

```sh
node tools/backup-rehearsal.ts \
  --out "$PWD/.artifacts/backup-rehearsal.json"
```

The rehearsal exercises the runtime snapshot code path end to end against a fresh local runtime: it seeds and publishes a document, stops cleanly, takes an offline snapshot, restores into a brand-new directory, and requires the same checkpoint, journal content digest, document, and private draft digests. It also verifies the guard rails — a stray WAL sidecar is refused (`offline_required`), restoring onto the live directory is refused (`destination_exists`), and a snapshot nested inside the data directory is refused (`overlapping_paths`). After the clean stop the rehearsal asserts no real WAL/SHM sidecars remain; the WAL-refusal check then runs against a separate disposable copy of the databases, so the rehearsal never plants, overwrites, or deletes a WAL in the real snapshot source. The `details` record binds the run to the checkpoint transaction id, journal digest, and snapshot file hashes. `fabric_disaster_recovery_proven: false` records that a local rehearsal does not prove whole-network disaster recovery. CI runs this as `npm run test:backup`.

## Two-domain failure drill

```sh
node tools/multi-host-drill.ts \
  --out "$PWD/.artifacts/multi-host-drill.json"
```

The drill starts two independent worker processes with separate roots and databases — two administrative domains on one machine. The first domain runs a `--write-every` commit loop that reports each write's begin and commit acknowledgements; the drill waits for at least one acknowledged commit plus a write in flight, then delivers `SIGKILL` and verifies `signalCode`. A non-empty `shared-ledger.sqlite-wal` sidecar must survive the kill, and a control copy of the main database file alone — taken before recovery — must lack commits the replayed journal holds, so WAL replay is proven rather than assumed. Every acknowledged commit must appear in the recovered journal. The peer must keep its verified state untouched (identical checkpoint and full journal/drafts digests) and exit with code 0 and no signal on `SIGTERM`. The killed domain's snapshot restore is then compared content-exact against the replayed state. The `details` record binds worker pids, signals, exit code, WAL sidecar size, writes begun, acknowledged and interrupted writes, main-db-only and recovered event counts, and recovered checkpoints/digests. The evidence record marks `physical_hosts: false` and `administrative_boundary: "process+filesystem"` explicitly: this harness verifies process/filesystem administrative independence, not independent physical hosts or Fabric channel fault isolation. CI runs this as `npm run test:drill:multi-host`.

## Result interpretation

`functional_assertions` and `assessment.*_pass` are pass/fail evidence for the behavior checks. `metrics` are measurements from the current machine and dataset, not fixed acceptance thresholds. The explicit `fabric_sla_proven: false` field records that local-simulation timings and the fixture peer outage do not establish Fabric production SLOs.

The focused regression coverage is:

```sh
node --test test/automation/experiments.test.ts
npm run check:types
```
