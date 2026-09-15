# Restricted design validator

Run from the project root with:

```sh
python3 tools/validate_design.py
```

`validate_design.py` uses only the Python standard library. It checks the
four JSON Schema Draft 2020-12 documents in `schemas/`, rejects schema
keywords outside the deliberately small supported subset, validates every
example, computes each `DocumentRevision` digest, and checks that parent,
dependency, decision, policy, and manifest references bind to the exact
fixture digests. Negative fixtures demonstrate rejection of a changed
body under an old digest, an unknown revision reference, a missing proposal binding, runtime agreement IDs inside document content, and invalid normative/reference manifest shapes. The latter is an intentionally unknown digest reference; it
does not claim to prove runtime freshness or ledger state.

Structural limits include 256 KiB UTF-8 Markdown bodies, 512 KiB canonical
payloads, at most two parents, 32 dependencies, and dependency traversal depth eight (revision history is not capped). JSON
objects are parsed with duplicate-key rejection.

The digest preimage is the `payload` object inside the revision wrapper;
`revision_digest` is excluded. The validator's canonical JSON routine is a
narrow fixture check: property names must be ASCII, strings must not contain
lone surrogates, integers must be safe integers, and floating point values
are rejected. It is designed to make these artifacts reviewable without
installing `jsonschema` or `rfc8785`.

`usage_scope` is a versioned identifier such as `review-invitation/v1`; a
published version is immutable and must never be redefined in place. The
manifest checkpoint records channel, block, transaction index, transaction
ID, and block hash because a later transaction in the same block can change
the applicable state. `membership_epoch` means the ledger application's
entitlement epoch; it is not an external SSO epoch or an automatic Fabric
membership synchronization marker. `eligibility_epoch` in the checkpoint changes for every ledger eligibility mutation; it is distinct from the application membership epoch. Approval payloads bind an organization,
actor, subject, and role-binding version. Runtime registry checks and an
organization signing gateway remain outside this validator; an organization
gateway assertion does not claim proof of an individual's physical presence.

Each v1 revision is bound to one acceptance-slot tuple: channel, document,
context, scope, and versioned usage scope. Reusing the content in another
scope requires a new revision or mapping that references the source.

This is a restricted design-contract check, not a general JSON Schema or
RFC 8785 production implementation. It is also not runtime consensus,
membership, authorization, freshness, or signature verification. The
contracts are unsigned payloads. Transport signatures, organization gateway
attestation, human-role registry checks, and approval evidence are external
runtime concerns.

`RunContextManifest.private_sources` defaults to an empty list. If populated,
it carries only local private identifiers, revision digests, custodian
organization IDs, and source classifications. It carries no private body and
does not make the source a shared accepted agreement; it is a local
`domain_reference` for runtime handling.

The v1 policy selects exactly one named representative for each required role. The fixtures check that both matching actors approve the same mapping revision; they do not authenticate those actors. Agreement IDs appear in normative manifest references and are resolved against runtime ledger state, not embedded in immutable document content.

The wire `scope_id` is an immutable business-scope identifier; `usage_scope` is a versioned usage definition. The acceptance slot binds both along with channel/document/context. Other-scope reuse creates a separate document or mapping referencing the original. `subject_id` in decision examples is a business subject, while `actor_id` names the attributed actor; neither string is authentication.

`retrieval_profile_id`, `authorization_snapshot_id`, and `model_egress_policy_version` point to local, versioned runtime configuration. They document what was supplied; their presence is not proof of freshness or authority. `source_kind=llm_drafted` indicates origin only and does not grant automatic approval.

Approval decisions sign an immutable `proposal_id` in addition to revision/slot/policy bindings. Fresh review after suspension requires a new proposal ID, so old signed approval payloads cannot authorize the new review. The same proposal ID is included in manifest decision references. The restricted schema engine supports `oneOf` for the manifest discriminator and the retract-target requirement.

Local Markdown references, balanced fences, and Python syntax can be checked with `python3 tools/check_docs.py`. This does not render Mermaid or assert full Mermaid grammar validity.
