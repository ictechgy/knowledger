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
- Public release: `v0.1.0` (2026-09-16), `v0.2.0` (2026-09-18)

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
7. **Certificate maintenance** — next scheduled check/renewal around early
   January 2027 (`docs/27-TEST-CERTIFICATES.md`).
8. **Known limitations** — the resident large cache entry is evicted by
   crossing large queries, and ledger `fork()` still copies state per block
   (`docs/VALIDATION.md`).

## Track C — Adoption and extensions

9. ~~**Additional source connectors**~~ — `readGitSource` reads the same
   manifest/snapshot contract from a pinned commit of a local Git
   repository (`kb-sync --git-ref`); further connectors remain open
   (`docs/23-KB-SOURCE-CONNECTOR.md`).
10. **Adoption pilot** — measurement support implemented:
    `npm run pilot:metrics` derives time-to-agreement, review effort and
    reuse rate from the verified journal and combines them with an
    explicit observation log for interpretation mixing and disclosure
    burden (`docs/28-ADOPTION-PILOT.md`); running an actual pilot remains
    open (`docs/07-DELIVERY-PLAN.md`).

## Track D — Project operations

11. **Release cadence** — keep `CHANGELOG.md` current; tag a release when
    main accumulates a coherent set of changes.
12. **Dependency policy** — pin Fabric image/proto versions deliberately;
    record upgrades with the same verification rigour as code changes.

## Out of scope for now

- A new consensus algorithm — Hyperledger Fabric remains the ledger
  foundation; the project is about semantic agreement, not infrastructure
  consensus.
- CFT→BFT migration and channel splits — these are real trust/configuration
  migrations that need the multi-host groundwork first.

## Contributing

`CONTRIBUTING.md` covers the ground rules. Roadmap items marked Track A or
Track B touch protocol contracts — discuss before changing their behaviour.
