# Project instructions

This is an MIT-licensed knowledge agreement ledger. The design in `docs/` is the protocol baseline; record deliberate deviations as decisions.

Read [HANDOFF.md](HANDOFF.md) for continuation state; use this file for durable repository rules.

## Global Rules

- Hyperledger Fabric is the selected network ledger foundation. Keep knowledge approval rules separate from infrastructure consensus; do not build a new consensus algorithm for this product.
- Preserve department-private source boundaries. Shared document content is visible to channel infrastructure operators.
- Never treat a local simulation, an orderer acknowledgement, or a chaincode event as proof of a VALID Fabric commit.
- Shared document revisions are immutable. Approvals bind the proposal, revision digest, full slot, policy version, membership epoch, and role binding version.
- AI actors may draft but may not issue human approvals.
- Keep consensus transitions deterministic, atomic, and testable. Use the same domain rules in the local and Fabric adapters.
- Keep generated identities, credentials, runtime databases, and downloaded tools out of Git.

## Scoped Guidance Index

There are no child `AGENTS.md` files. All existing rules are repository-wide. Any future child links here are a discovery index; their instructions apply only within their directory and descendants.

## Verification

- Add regression tests for authorization, idempotency, approval replay, objections, stale reads, and dependency withdrawal when changing those behaviors.
- Run `npm run check` for runtime changes and `npm run demo` for end-to-end agreement changes. For documentation-only changes, check links and structure with `python3 -B tools/check_docs.py`; avoid repeating unchanged runtime checks.
- For TypeScript changes, also run `npm run check:types` after installing the locked root development and `packages/fabric` dependencies. Keep the local runtime usable without those optional development/Fabric installations.
- Commit only files owned by the current change after relevant checks. Do not publish remotely without an explicit request.
