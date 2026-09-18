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

Design contracts in `docs/` that are not yet implemented:

1. **Organizational signing gateway** — move actor signing out of the service
   into a per-organization gateway process, starting with development keys.
   See `docs/04-SECURITY.md`.
2. **SSO adapter interface** — OIDC abstraction so the development login
   becomes one local implementation of a real authentication boundary.
3. **Vector search read model** — pgvector candidate search with ledger
   eligibility re-verification; vector results alone must never conclude
   "no knowledge exists". See `docs/05-RAG.md`.
4. **Model egress gate** — re-check SSO/access/model permissions immediately
   before returning RAG responses.

## Track B — Operations maturity

5. **Multi-host failure drills** — extend single-host container tests to two
   physical hosts so independent-administration claims are actually verified.
6. **Backup/restore rehearsal automation** — promote the snapshot restore
   procedure to a repeatable, CI-level check.
7. **Certificate maintenance** — next scheduled check/renewal around early
   January 2027 (`docs/27-TEST-CERTIFICATES.md`).
8. **Known limitations** — the resident large cache entry is evicted by
   crossing large queries, and ledger `fork()` still copies state per block
   (`docs/VALIDATION.md`).

## Track C — Adoption and extensions

9. **Additional source connectors** — git repositories or other source
   formats beyond local Markdown (`docs/23-KB-SOURCE-CONNECTOR.md`).
10. **Adoption pilot** — the P4 plan measures one concept and one real
    cross-context workflow: interpretation mixing, time-to-agreement,
    review effort, disclosure burden, reuse rate (`docs/07-DELIVERY-PLAN.md`).

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
