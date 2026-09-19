# Changelog

All notable changes to Knowledger are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- HTTP shutdown now sweeps idle keep-alive connections immediately and
  keeps re-sweeping while close waits, still waits for in-flight requests to
  finish, and force-releases any remaining sockets after a five-second
  deadline — reported on stderr with the server label and remaining
  connection count when forced — so a stuck request or a polling client can
  no longer hang `server.close()`. The API server and the development OIDC
  issuer share the same `closeHttpServer` implementation (`packages/http`),
  and the deadline is tunable via `shutdownDeadlineMs` on both apps.

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

[0.2.0]: https://github.com/ictechgy/knowledger/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ictechgy/knowledger/releases/tag/v0.1.0
