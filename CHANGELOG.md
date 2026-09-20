# Changelog

All notable changes to Knowledger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Application-local review comments, mentions, human assignees, due dates,
  recurring reviews and recipient-scoped read notifications. Revision binding,
  atomic event/notification storage, schedule CAS and idempotent retries preserve
  the existing approval and use-control contracts. Stopped-app backups include
  the records; organization-scoped Fabric applications do not replicate them.
- Verified reverse dependency impact with exact-checkpoint pagination, required
  versus informational paths, current eligibility and actions to open or revise
  the pinned affected revision. Review completion never creates an approval.
- Three starter document templates, read-only Git/Markdown sync previews
  (`--dry-run`) and optional bounded retries (`--retries 0..3`).
- Configured-runtime embedding/index injection and labeled retrieval evaluation:
  precision/recall/MRR at k, unexpected releases and unexpected withholding.
  Actual embedding providers and customer KB integrations remain deployment work.
- Review workflow guide and a separate, unimplemented governance migration design.

## [0.5.0] — 2026-09-20

### Added

- Dependency authoring for new drafts, private draft edits and Markdown imports:
  callers select shared revision digests, relationships and enforcement, and
  the server derives the full slot from the verified canonical revision. Omitted
  references preserve the existing set; an explicit empty array removes it.
  Reference changes create a new immutable revision and require fresh approvals.
- A browser reference picker with paginated shared-revision search, condition
  editing/removal, inherited-reference loading and publication-preview display.
  Selected parents and references stay pinned across overview refreshes.
- Deployment preparation guide covering actual pilot inputs, independent-host
  fault evidence and SSO/signing/model integration boundaries. Correct the
  configured signer example to include its organization, required attestation
  and audit log.

## [0.4.0] — 2026-09-20

### Added

- Fabric adoption measurement: `pilot:metrics --mode fabric` reads a stopped
  projection in one read-only SQLite snapshot, replays the raw full blocks
  through the shared verifier, and aggregates only transactions marked VALID.
  Explicit channel, chaincode/version and public genesis bindings are required.
  Output includes exact VALID transaction bounds, the full block tip and a
  raw-journal digest; derived SQL rows never supply measurement events. This is
  offline replay of a caller-trusted projection, not live peer authentication.
  Local mode and its schema-version-1 result remain compatible and do not
  require optional Fabric dependencies. Both modes stream events into the
  shared metric aggregator.

## [0.3.0] — 2026-09-20

### Added

- Release and dependency maintenance policy, with exact pins, upgrade
  verification, compatibility notes and rollback criteria; adoption pilot
  plan/results and empty observation-log templates.
- Organisation signing-gateway attestation: the remote sign request can carry a
  decision attestation (actor, organisation, command binding, Fabric phase and
  transaction ID) or a read-only `phase: "query"` attestation for status and
  evaluate signing. The signing service verifies it against the certificate's
  `kcl.actor_*` attributes and the key's configured `org_id` before signing,
  restricts attested signing to human actors by default via
  `allowed_actor_kinds`, and issues an `attestation_signature` receipt plus a
  JSONL audit record (`--audit-log`) as the organisation's testimony.
- `require_attestation` key policy: protected keys reject unattested requests
  and attested signing always requires an organisation binding, so no
  client-claimed organisation is signed into evidence. Development signing keys
  enable it.
- `SigningAttestation`/`QueryAttestation`/`SigningAttestationContext` protocol
  types, `decisionAttestation`/`queryAttestation` helpers and the consume-once
  `attestationSlot`; the gateway client installs the attestation immediately
  before the SDK's endorse, submit, status and evaluate signing calls, and the
  remote signer cryptographically verifies each receipt, rejecting missing or
  forged ones.
- `createAttestationSerializer`: every signer-bearing SDK call on a gateway
  connection is serialised so a concurrent status/evaluate lookup can never
  overwrite or steal an in-flight decision attestation, one context may be
  claimed by a single serializer, and the qscc lookup gateway signs through a
  dedicated slot and signer. Decision attestations must carry the SDK-assigned
  `tx_id`, and the gateway validates builder output before installing it — a
  write attestation must match the operation's command identity, recomputed
  digest, phase and transaction ID, and a read attestation must be
  query-shaped. Verified receipts can be surfaced to callers through
  `onAttestationReceipt`, whose own failures stay distinct from malformed
  protocol responses.
- `createOidcAdapter` SSO boundary in `packages/auth/adapter.ts`: a shared
  `(issuer, subject) → Actor` resolver compares the issuer by exact string
  equality (OIDC `iss` semantics — URL aliases are rejected) and maps only
  configured subjects — actor selection never comes from browser input or
  token claims. The configured issuer must equal the provider's discovered
  issuer or the adapter fails at construction. The API runtime, the
  order-workflow auth runtime, and the auth smoke tool all build the
  `ApplicationAuthentication` boundary through the adapter.
- Vector candidate search read model (`POST …/vector-search`): a derived
  `VectorCandidateIndex` port ranks document candidates by embedding
  similarity while every candidate is re-verified against verified ledger
  state at the request checkpoint — the index never authorizes knowledge.
  `document_ids` required refs always resolve directly against the verified
  browse index, results carry `candidate_source` and a `complete` flag (an
  empty index page is never proof that no knowledge exists), and stale index
  digests are dropped. `LocalVectorIndex` provides the in-process development
  adapter; `PgVectorIndex` targets pgvector with an `index_version`-scoped
  schema and lazily loaded `pg` dependency.
- Fabric adapter refresh watchdog: the refresh-abandon timer no longer uses
  `unref()`, which previously let the event loop drain before
  `FRESHNESS_UNAVAILABLE` fired when the stuck refresh was the only pending
  work — a stuck refresh now deterministically abandons after
  `refreshTimeoutMs` and may hold the event loop for that bound.
- Server-side model egress gate: `KnowledgerService`/`createApp`/
  `createConfiguredApp` accept a `modelEgress` policy (`policy_version` lands
  in the manifest's `model_egress_policy_version`; `allows` is consulted
  whenever the caller names a `model_adapter_id`). `resolve` withholds
  `EGRESS_POLICY_DENIED` before issuing a manifest — adapter requests are
  denied outright when no `allows` hook is configured — and `revalidate`
  re-checks the current policy immediately before release against the adapter
  bound into the run record, rejecting a different or missing adapter with
  `EGRESS_ADAPTER_MISMATCH` and distinguishing a throwing or timed-out policy
  hook as `EGRESS_POLICY_UNAVAILABLE` (`timeout_ms`, reported through the
  `onError` diagnostic). The policy, membership-epoch, egress-version and
  retrieval-profile bindings plus approval decisions are compared server-side
  instead of relying on client validation alone. A per-boot HMAC integrity
  stamp seals the run id, slot, adapter binding, issuance manifest, and issuing
  actor so vault tampering — rewriting the bound adapter, deleting the key, or
  swapping the stored manifest for currently-valid values — is detected as
  `KNOWLEDGE_CHANGED`, and tamper-detected responses omit the stored
  checkpoint.
  `modelEgress.require_adapter` opts a deployment into rejecting adapter-less
  resolves with `EGRESS_ADAPTER_REQUIRED`. `guardedGeneration` now forwards
  its `adapterId` through `resolve` and both `revalidate` calls so the server
  policy gate covers generate and release. Deployment notes: callers that pass
  `model_adapter_id` without a configured `allows` hook now fail closed
  (`EGRESS_POLICY_DENIED`) — configure `modelEgress.allows` where adapter
  egress is intended; revalidation refreshes the same run instead of minting
  a new run id, persists the latest refreshed manifest on the run record's
  `last_refreshed_manifest` field for audit while the issuance manifest stays
  the anchor, and the client requires the run id to match, so server and
  client should be deployed together.
- CI operations drills: `npm run test:backup` rehearses the offline runtime
  snapshot/restore procedure end to end — clean stop (asserting no real
  WAL/SHM sidecar survives it), snapshot, restore into a new directory, and
  checkpoint/journal-digest/private-draft-digest equivalence, plus the
  WAL-sidecar, existing-destination and overlapping-path refusals; the
  `details` record binds checkpoint, journal digest, and snapshot file
  hashes. `npm run test:drill:multi-host` runs a two-administrative-domain
  failure drill: one worker process keeps committing writes and is
  force-killed mid-operation — a non-empty WAL sidecar must survive — while
  the peer keeps its verified state and exits with code 0 on SIGTERM, and
  the killed domain recovers through WAL replay and a snapshot restore —
  the evidence marks the process+filesystem boundary explicitly (not
  physical hosts) and binds pids, signals, exit codes, and recovered
  checkpoints.
- Git source connector: `readGitSource` produces the same manifest/snapshot
  contract from a pinned commit of a caller-provided local Git repository —
  revision refs resolve to a commit, only regular `100644` blobs inside the
  manifest allowlist are read, and cloning/fetching/credentials stay with
  the caller. `kb-sync --git-ref` selects it.
- Adoption pilot measurement: `npm run pilot:metrics`
  (`tools/adoption-metrics.ts`) derives time-to-agreement, review effort
  and reuse rate from the verified journal and combines them with a
  strictly-validated observation log (interpretation mixing, review
  questions, disclosure burden) into a schema-versioned measurement
  record.
- Signing audit hardening: the audit log path may not collide with configured
  key, certificate, socket or signing configuration paths — hard links and
  non-regular targets are refused — records are appended in one write call,
  flushed before the response is acknowledged and the descriptor is released
  on shutdown; a record that throws mid-write marks the log torn so later
  signing fails closed until the file is repaired. Rejection records carry a `reason` and the
  configured certificate's actor claims. Attested keys fail fast at load when
  the certificate's `actor_kind` is outside `allowed_actor_kinds` or the
  private key is not EC, and any organisation-bound signing key cannot start
  without `--audit-log` so the service-side evidence chain always exists; the
  development signing service derives its audit log beside the socket when no
  path is given. A pre-existing audit file must end with a newline-terminated
  record — an unterminated tail is refused at startup rather than repaired so
  a torn write cannot merge records — and an attested request holds its
  concurrency slot until both the digest and evidence signatures settle.

### Changed

- Browse and substring-search caches keep up to eight large result sets
  per pool using LRU eviction within the existing combined large-result
  budgets (estimated 16 MiB for browse refs, 64 MiB of UTF-8 search keys/IDs).
  Alternating large queries can reuse their pages while normal entries keep
  their separate budgets; checkpoint and authorization checks are preserved.
- Fabric durable block ingestion now stages verified write deltas and
  publishes them only after SQL commit, eliminating the per-block full
  state-map copy. Prepared blocks reject repeat or stale commits; explicit
  `fork()` still provides an independent snapshot when requested.
- Startup-breaking signing policy: organisation-bound keys now refuse to start
  without `--audit-log`, non-EC private keys and certificates whose
  `actor_kind` is outside `allowed_actor_kinds` fail at load rather than at
  first request, and a pre-existing audit file with an unterminated tail is
  refused at startup. An attestation builder returning `undefined` or claims
  that mismatch the signed operation now fails the call locally instead of
  letting the operation proceed unattested, a signing call whose attestation
  is never consumed by the signer fails closed rather than returning a
  signature without evidence, records arriving after audit-log close fail the
  request, and a partially written audit
  record marks the log torn so later signing fails closed until the file is
  repaired.

### Fixed

- Configured Fabric smoke now uses an organization-bound key with required
  attestation and an audit log, injects the explicit local model egress policy
  at startup and restore, and checks that unattested signing and an unapproved
  model adapter are rejected before generation.
- HTTP shutdown now sweeps idle keep-alive connections immediately and
  keeps re-sweeping while close waits, still waits for in-flight requests to
  finish, and force-releases any remaining sockets after a five-second
  deadline — reported on stderr with the server label, the reason
  (forced release vs a missing close callback) and the affected
  connection count — so a stuck request, an untracked socket, or a polling
  client can no longer hang `server.close()`. The API server and the
  development OIDC issuer share the same `closeHttpServer` implementation
  (`packages/http`), resource teardown still runs when shutdown fails, and
  the deadline is tunable via `shutdownDeadlineMs` on both apps.
  `app.close()` now runs each teardown stage independently and reports
  failures together — a single failure rethrows the original error, and
  multiple failures surface as one `AggregateError` naming the failed
  stages.

## [0.2.0] — 2026-09-18

### Added

- Operational status dashboard for verified ledger state and outbox
  observation (`e69a228`).
- Performance baseline tooling: JSON baseline comparison, explicit regression
  thresholds, multi-query and cold/warm search measurements, and a synthetic
  Fabric-adapter workload with journal identity digests (PR #3, PR #4).
- `tools/performance-compare.ts` shared comparison module with schema,
  environment, dataset, and metric validation plus output-path collision
  protection for baselines.
- CI coverage for the Fabric comparison path in the `fabric-boundaries` job.

### Changed

- Large read path optimised with `readMany`, request-level caching, and
  prefetching (PR #1).
- Browse and search are paginated; block ingest no longer degrades
  quadratically — validated against a 100,000-document ledger (PR #2).

### Fixed

- Detect and reconnect peer connections silently dropped by gRPC keepalive
  (`26e75a8`).
- Bound stalled ledger refreshes so readiness recovers instead of hanging
  permanently (`f189e80`).

## [0.1.0] — 2026-09-16

First public development alpha.

- Knowledge agreement ledger on Hyperledger Fabric foundations: immutable
  shared revisions, slot-bound approvals tied to proposal, revision digest,
  policy version, membership epoch, and role-binding version.
- Deterministic local simulation adapter sharing the same domain rules as the
  Fabric adapter.
- Browser UI, Markdown KB source connector, development login, and private
  drafting workflow.
- Example order-workflow fixture (sales/fulfillment/settlement remain optional
  example content, not product defaults).
- Failure drills: peer/orderer outage, SIGKILL during certificate apply, and
  runtime snapshot restore.

[Unreleased]: https://github.com/ictechgy/knowledger/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ictechgy/knowledger/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ictechgy/knowledger/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ictechgy/knowledger/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ictechgy/knowledger/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ictechgy/knowledger/releases/tag/v0.1.0
