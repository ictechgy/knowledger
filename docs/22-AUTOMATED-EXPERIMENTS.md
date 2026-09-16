# Automated performance and resilience experiments

The repository includes two repeatable, local-only experiment harnesses. They exercise the real `KclService`, `LocalLedger`, `PrivateStore`, snapshot code, and HTTP server paths. They never connect to the Fabric network, use port 4317, or modify an existing runtime directory.

## Performance smoke

```sh
node tools/performance-smoke.ts \
  --documents 8 --samples 3 --body-bytes 1024 \
  --out "$PWD/.artifacts/performance-smoke.json"
```

The default dataset is intentionally small for CI. Use a separate disposable `--data` directory and `--documents 1000` or more for a larger local measurement. `--documents` is bounded at 10,000, `--samples` at 1,000, and `--body-bytes` at 256 KiB. The harness creates deterministic synthetic titles, document IDs, and body markers; it reports no document body.

The run publishes every synthetic document through the private draft, preview, and publish service path. It then measures repeated search and overview reads, closes and reopens the SQLite runtime to measure journal replay, and checks the database footprint. Every result includes p50, p95, and maximum elapsed time for each sampled operation, along with the requested dataset and runtime version.

## Resilience smoke

```sh
node tools/resilience-smoke.ts \
  --out "$PWD/.artifacts/resilience-smoke.json"
```

The harness starts a separate Node worker against a new local runtime, commits a synthetic publication, force terminates the worker, and reopens the databases. It retries the same command and requires the same checkpoint without a second journal event. It also performs an offline runtime snapshot and restore into a new directory, then compares recovered state. A separate in-memory peer fixture is used only to make the HTTP API return strict 503 responses while unavailable; recovery must return 200 without changing the fixture event count.

Both harnesses clean up their automatically-created `.data` directory. Supplying `--data` or `--root` keeps the caller-owned disposable directory for inspection; an existing nonempty directory is rejected. CLI paths can be relative to the current directory. `--out` writes a mode-0600 JSON artifact under a caller-selected path. Errors go to generic stderr and do not include bodies, cookies, credentials, or filesystem contents.

## Result interpretation

`functional_assertions` and `assessment.*_pass` are pass/fail evidence for the behavior checks. `metrics` are measurements from the current machine and dataset, not fixed acceptance thresholds. The explicit `fabric_sla_proven: false` field records that local-simulation timings and the fixture peer outage do not establish Fabric production SLOs.

The focused regression coverage is:

```sh
node --test test/automation/experiments.test.ts
npm run check:types
```
