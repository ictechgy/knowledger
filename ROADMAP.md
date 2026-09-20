# Roadmap

Knowledger is a public development alpha. The protocol baseline lives in
`docs/`; this roadmap tracks which parts of that design are implemented,
verified, or still planned. Items are grouped by track, not by promised date.

## Done

- Local simulation adapter sharing the domain rules with the Fabric adapter
- Order-workflow example fixture, browser UI, development login, private
  drafting, Markdown KB source connector
- Operational dashboard for verified ledger state and outbox observation
- 100,000-document scalability: paginated browse/search, non-quadratic block
  ingest
- Performance baseline tooling with explicit regression thresholds and
  cold/warm search scenarios
- Container-level failure drills: peer/orderer outage, SIGKILL during
  certificate apply, runtime snapshot restore
- Public release: `v0.1.0` (2026-09-16), `v0.2.0` (2026-09-18),
  [`v0.3.0`](https://github.com/ictechgy/knowledger/releases/tag/v0.3.0) (2026-09-20)

## Track A — Protocol completeness

Design contracts in `docs/` and their implementation status:

1. **Organizational signing gateway** — implemented: per-organization remote
   signing service with attestation, receipts and audit (PR #6).
2. **SSO adapter interface** — implemented: shared `createOidcAdapter`
   boundary (PR #7).
3. **Vector search read model** — implemented: `VectorCandidateIndex` port
   with pgvector adapter and ledger eligibility re-verification (PR #8).
   See `docs/05-RAG.md`.
4. **Model egress gate** — implemented: `modelEgress` server policy checked
   at `resolve` and re-checked at `revalidate` before release (PR #9).

## Track B — Operations maturity

5. **Multi-host failure drills** — a two-domain drill harness now verifies
   process/filesystem administrative independence in CI
   (`tools/multi-host-drill.ts`); independent physical hosts and Fabric
   channel fault isolation remain open.
6. ~~**Backup/restore rehearsal automation**~~ — `npm run test:backup`
   (`tools/backup-rehearsal.ts`) rehearses the offline snapshot/restore
   procedure, including its refusal guards, in CI.
7. **Certificate maintenance** — public-certificate check passed on
   2026-09-20 (81 certificates). Next manual check on 2027-01-01, inside the
   14-day warning window; no automatic renewal job is installed
   ([procedure](docs/27-TEST-CERTIFICATES.md)).
8. **Known scalability limitations** — addressed: large browse/search
   results share bounded LRU pools within the existing aggregate byte caps;
   durable Fabric ingestion stages only block writes and publishes them
   after SQL commit, removing the per-block state-map copy. Eviction above
   the budgets, cold search and historical replay costs remain explicit
   ([constraints](docs/26-BROWSE-INDEX.md)).

## Track C — Adoption and extensions

9. ~~**Additional source connectors**~~ — `readGitSource` reads the same
   manifest/snapshot contract from a pinned commit of a local Git
   repository (`kb-sync --git-ref`); further connectors remain open
   (`docs/23-KB-SOURCE-CONNECTOR.md`).
10. **Adoption pilot** — measurement support implemented:
    `npm run pilot:metrics` derives time-to-agreement, review effort and
    reuse rate from a verified local journal or stored Fabric full blocks
    (`--mode fabric`, VALID transactions only) and combines them with an
    explicit observation log for interpretation mixing and disclosure
    burden; a plan/results template and empty observation log are available
    ([pilot guide](docs/28-ADOPTION-PILOT.md)). Running an actual pilot still
    requires participating organizations, a deployment and human reviewers.

## Track D — Project operations

11. **Release cadence** — defined: four-week review, coherent minor releases,
    urgent corrective patches, compatibility notes, verification and
    publication readback ([release procedure](docs/29-PROJECT-OPERATIONS.md)).
12. **Dependency policy** — defined: exact package versions and lockfiles,
    Fabric image digests and CI action SHAs, scoped upgrade validation and
    rollback criteria ([dependency policy](docs/29-PROJECT-OPERATIONS.md)).

## Out of scope for now

- A new consensus algorithm — Hyperledger Fabric remains the ledger
  foundation; the project is about semantic agreement, not infrastructure
  consensus.
- CFT→BFT migration and channel splits — these are real trust/configuration
  migrations that need the multi-host groundwork first.

## Contributing

`CONTRIBUTING.md` covers the ground rules. Roadmap items marked Track A or
Track B touch protocol contracts — discuss before changing their behaviour.
