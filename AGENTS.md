# Project instructions

This is Knowledger, an MIT-licensed knowledge agreement ledger. The design in `docs/` is the protocol baseline; record deliberate deviations as decisions.

Read [HANDOFF.md](HANDOFF.md) for continuation state; use this file for durable repository rules.

## Global Rules

- Organizations, roles, and workflows come from project configuration. Sales/fulfillment/settlement belong to the optional `examples/order-workflow` fixture; do not make them product defaults.
- Hyperledger Fabric is the selected network ledger foundation. Keep knowledge approval rules separate from infrastructure consensus; do not build a new consensus algorithm for this product.
- Preserve department-private source boundaries. Shared document content is visible to channel infrastructure operators.
- Never treat a local simulation, an orderer acknowledgement, or a chaincode event as proof of a VALID Fabric commit.
- Shared document revisions are immutable. Approvals bind the proposal, revision digest, full slot, policy version, membership epoch, and role binding version.
- AI actors may draft but may not issue human approvals.
- Keep consensus transitions deterministic, atomic, and testable. Use the same domain rules in the local and Fabric adapters.
- Keep generated identities, credentials, runtime databases, and downloaded tools out of Git.
- The product name is Knowledger. `kcl:` ledger state keys, `kcl.actor_*` certificate attributes, the `kcl.test-certificate-renewal` plan schema, and the deployed example fixture's names (channel `kcl-demo`, chaincode `kcl`/`kcl_0.1.0`, compose project `kcl-fabric-smoke`, domain `*.kcl.test`) are persisted contracts of the running network, issued certificates, and committed ledger state. Do not rename them; regenerated networks keep the same fixture naming.
- Derive browse indexes and caches from verified journal state; they do not authorize knowledge use. Preserve canonical-value checks, exact checkpoints, and fresh authorization/eligibility checks. See [browse index constraints](docs/26-BROWSE-INDEX.md).

## Runtime & Data Preservation

- Preserve existing workspaces, private data, keys, and ledger genesis. Do not rerun fresh-network initialization or the one-shot `fabric:smoke` against a completed fixture. Use [Fabric continuation procedures](infra/fabric/README.md) for an existing network.
- Before stopping an application, verify its PID, command, and working directory; shut it down gracefully. Take database snapshots with the application stopped and restore into a new directory. Do not delete WAL/SHM files to bypass validation. See [runtime backup](docs/16-RUNTIME-BACKUP.md).
- For disposable User1 certificate renewal, follow [certificate maintenance](docs/27-TEST-CERTIFICATES.md): preserve existing keys, run one maintenance operation at a time, and reload both applications and signers after apply. This procedure does not authorize production credentials or CA/TLS rotation.

## Scoped Guidance Index

There are no child `AGENTS.md` files. All existing rules are repository-wide. Any future child links here are a discovery index; their instructions apply only within their directory and descendants.

## Verification

- Add regression tests for authorization, idempotency, approval replay, objections, stale reads, and dependency withdrawal when changing those behaviors.
- Use Node 24 or later. Run `npm run check` for runtime changes and `npm run demo` for end-to-end agreement changes. For documentation-only changes, check links and structure with `python3 -B tools/check_docs.py`; avoid repeating unchanged runtime checks.
- For TypeScript changes, also run `npm run check:types` after installing the locked root development, `packages/fabric`, and `packages/auth` dependencies. Keep the local runtime usable without those optional development/Fabric/auth installations. Use only erasable TypeScript syntax for the native Node runtime.
- Commit only files owned by the current change after relevant checks. Do not publish remotely without an explicit request.
