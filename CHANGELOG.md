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
  `tx_id`. Verified receipts can be surfaced to callers through
  `onAttestationReceipt`, whose own failures stay distinct from malformed
  protocol responses.
- Signing audit hardening: the audit log path may not collide with configured
  key, certificate, socket or signing configuration paths — hard links and
  non-regular targets are refused — records are written completely, flushed
  before the response is acknowledged and the descriptor is released on
  shutdown. Rejection records carry a `reason` and the configured
  certificate's actor claims. Attested keys fail fast at load when the
  certificate's `actor_kind` is outside `allowed_actor_kinds` or the private
  key is not EC.

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
