# Project instructions

This is an MIT-licensed knowledge agreement ledger. The design in `docs/` is the protocol baseline; record deliberate deviations as decisions.

- Preserve department-private source boundaries. Shared document content is visible to channel infrastructure operators.
- Never treat a local simulation, an orderer acknowledgement, or a chaincode event as proof of a VALID Fabric commit.
- Shared document revisions are immutable. Approvals bind the proposal, revision digest, full slot, policy version, membership epoch, and role binding version.
- AI actors may draft but may not issue human approvals.
- Keep consensus transitions deterministic, atomic, and testable. Use the same domain rules in the local and Fabric adapters.
- Add regression tests for authorization, idempotency, approval replay, objections, stale reads, and dependency withdrawal when changing those behaviors.
- Keep generated identities, credentials, runtime databases, and downloaded tools out of Git.
- Commit only files owned by the current change after relevant checks. Do not publish remotely without an explicit request.
