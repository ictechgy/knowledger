#!/usr/bin/env python3
"""Restricted, stdlib-only checks for the KCL design contracts.

This is deliberately a design-contract validator.  It is not a general JSON
Schema implementation, a production RFC 8785 implementation, or runtime
consensus/signature verification.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas"
EXAMPLES = ROOT / "examples"
SAFE_INTEGER = 9007199254740991
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class DesignError(Exception):
    pass


def fail(message: str) -> None:
    raise DesignError(message)


def is_surrogate(value: str) -> bool:
    return any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def assert_jcs_values(value: Any, path: str = "$", *, property_name: bool = False) -> None:
    """Check the narrow JCS input subset used by these fixtures."""
    if isinstance(value, str):
        if is_surrogate(value):
            fail(f"{path}: lone surrogate is not permitted")
        if property_name and any(ord(char) > 0x7F for char in value):
            fail(f"{path}: property names must be ASCII")
    elif isinstance(value, bool) or value is None:
        return
    elif isinstance(value, int):
        if abs(value) > SAFE_INTEGER:
            fail(f"{path}: integer is outside the safe JCS range")
    elif isinstance(value, float):
        fail(f"{path}: floating point values are not permitted")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            assert_jcs_values(item, f"{path}[{index}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                fail(f"{path}: object property names must be strings")
            assert_jcs_values(key, f"{path}.{key}", property_name=True)
            assert_jcs_values(item, f"{path}.{key}")
    else:
        fail(f"{path}: unsupported JSON value {type(value).__name__}")


def jcs(value: Any) -> bytes:
    """Canonicalize the restricted fixture subset.

    ASCII property names make Python's code-point key ordering equivalent to
    the RFC 8785 ordering for this design.  ensure_ascii=False preserves body
    Unicode as UTF-8; the standard encoder supplies the required JSON escapes.
    """
    assert_jcs_values(value)
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        fail(f"JCS serialization failed: {exc}")
    return encoded.encode("utf-8")


def revision_digest(payload: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(jcs(payload)).hexdigest()


def json_equal(left: Any, right: Any) -> bool:
    """JSON equality, keeping booleans distinct from integers."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(json_equal(left[key], right[key]) for key in left)
    return left == right


SCHEMA_KEYWORDS = {
    "$schema", "$id", "$defs", "$ref", "title", "type", "properties", "required",
    "additionalProperties", "enum", "const", "pattern", "items", "minItems", "oneOf", "maxItems",
    "uniqueItems", "minLength", "maxLength", "minimum", "maximum",
}


def check_schema_shape(schema: Any, path: str = "$", root: Any | None = None) -> None:
    if root is None:
        root = schema
    if not isinstance(schema, dict):
        fail(f"schema {path}: schema node must be an object")
    unsupported = set(schema) - SCHEMA_KEYWORDS
    if unsupported:
        fail(f"schema {path}: unsupported keyword(s): {', '.join(sorted(unsupported))}")
    if "$ref" in schema:
        ref = schema["$ref"]
        if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
            fail(f"schema {path}: only local #/$defs refs are supported")
        target = root.get("$defs", {}).get(ref.removeprefix("#/$defs/"))
        if target is None:
            fail(f"schema {path}: unresolved local ref {ref}")
    if "oneOf" in schema:
        branches = schema["oneOf"]
        if not isinstance(branches, list) or not branches:
            fail(f"schema {path}: oneOf must be a non-empty array")
        for index, child in enumerate(branches):
            check_schema_shape(child, f"{path}.oneOf[{index}]", root)
    if "$defs" in schema:
        if not isinstance(schema["$defs"], dict):
            fail(f"schema {path}: $defs must be an object")
        for name, child in schema["$defs"].items():
            check_schema_shape(child, f"{path}.$defs.{name}", root)
    if "properties" in schema:
        if not isinstance(schema["properties"], dict):
            fail(f"schema {path}: properties must be an object")
        for name, child in schema["properties"].items():
            check_schema_shape(child, f"{path}.properties.{name}", root)
    for key in ("items",):
        if key in schema:
            check_schema_shape(schema[key], f"{path}.{key}", root)


def resolve_ref(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    ref = schema.get("$ref")
    if ref is None:
        return schema
    target = root
    for component in ref.removeprefix("#/").split("/"):
        target = target[component]
    return target


def validate_instance(instance: Any, schema: dict[str, Any], path: str, root: dict[str, Any]) -> None:
    schema = resolve_ref(schema, root)
    if "oneOf" in schema:
        matches = 0
        for child in schema["oneOf"]:
            try:
                validate_instance(instance, child, path, root)
            except DesignError:
                continue
            matches += 1
        if matches != 1:
            fail(f"{path}: must match exactly one schema alternative")
    if "type" in schema:
        expected = schema["type"]
        type_ok = {
            "object": isinstance(instance, dict),
            "array": isinstance(instance, list),
            "string": isinstance(instance, str),
            "integer": isinstance(instance, int) and not isinstance(instance, bool),
            "boolean": isinstance(instance, bool),
            "null": instance is None,
        }.get(expected)
        if type_ok is None:
            fail(f"{path}: unsupported schema type {expected!r}")
        if not type_ok:
            fail(f"{path}: expected {expected}")
    if "const" in schema and not json_equal(instance, schema["const"]):
        fail(f"{path}: expected const {schema['const']!r}")
    if "enum" in schema and not any(json_equal(instance, allowed) for allowed in schema["enum"]):
        fail(f"{path}: value is not in enum")
    if isinstance(instance, str):
        if "minLength" in schema and len(instance) < schema["minLength"]:
            fail(f"{path}: shorter than minLength")
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            fail(f"{path}: longer than maxLength")
        if "pattern" in schema and re.search(schema["pattern"], instance) is None:
            fail(f"{path}: does not match pattern")
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            fail(f"{path}: below minimum")
        if "maximum" in schema and instance > schema["maximum"]:
            fail(f"{path}: above maximum")
    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            fail(f"{path}: fewer than minItems")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            fail(f"{path}: more than maxItems")
        if schema.get("uniqueItems"):
            for index, value in enumerate(instance):
                if any(json_equal(value, prior) for prior in instance[:index]):
                    fail(f"{path}[{index}]: duplicate item violates uniqueItems")
        if "items" in schema:
            for index, value in enumerate(instance):
                validate_instance(value, schema["items"], f"{path}[{index}]", root)
    if isinstance(instance, dict):
        for required in schema.get("required", []):
            if required not in instance:
                fail(f"{path}: missing required property {required!r}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            extra = set(instance) - set(properties)
            if extra:
                fail(f"{path}: unsupported property(ies): {', '.join(sorted(extra))}")
        for name, child in properties.items():
            if name in instance:
                validate_instance(instance[name], child, f"{path}.{name}", root)


def load_json(path: Path) -> Any:
    def no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                fail(f"{path.relative_to(ROOT)}: duplicate JSON property {key!r}")
            result[key] = value
        return result

    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle, object_pairs_hook=no_duplicate_keys)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"{path.relative_to(ROOT)}: invalid JSON: {exc}")


def require_digest(value: Any, path: str) -> str:
    if not isinstance(value, str) or DIGEST_RE.fullmatch(value) is None:
        fail(f"{path}: expected sha256 digest")
    return value


def main() -> int:
    try:
        schemas = {path.name: load_json(path) for path in sorted(SCHEMAS.glob("*.schema.json"))}
        if set(schemas) != {
            "agreement-policy.schema.json", "approval-decision.schema.json",
            "document-revision.schema.json", "run-context-manifest.schema.json",
        }:
            fail("schema directory must contain exactly the four contract schemas")
        for name, schema in schemas.items():
            check_schema_shape(schema)

        schema_for = {
            "document_revision_sales.json": schemas["document-revision.schema.json"],
            "document_revision_fulfillment.json": schemas["document-revision.schema.json"],
            "document_revision_settlement.json": schemas["document-revision.schema.json"],
            "document_revision_review_invitation.json": schemas["document-revision.schema.json"],
            "negative_changed_body_old_digest.json": schemas["document-revision.schema.json"],
            "agreement_policy.json": schemas["agreement-policy.schema.json"],
            "approval_decision.json": schemas["approval-decision.schema.json"],
            "approval_decision_fulfillment.json": schemas["approval-decision.schema.json"],
            "negative_stale_decision_digest.json": schemas["approval-decision.schema.json"],
            "run_context_manifest.json": schemas["run-context-manifest.schema.json"],
            "negative_revision_runtime_agreement.json": schemas["document-revision.schema.json"],
            "negative_manifest_missing_agreement.json": schemas["run-context-manifest.schema.json"],
            "negative_manifest_reference_agreement.json": schemas["run-context-manifest.schema.json"],
            "negative_decision_missing_proposal.json": schemas["approval-decision.schema.json"],
        }
        actual_examples = {path.name for path in EXAMPLES.glob("*.json")}
        if actual_examples != set(schema_for):
            fail(f"example set mismatch: unexpected or missing files {sorted(actual_examples ^ set(schema_for))}")
        loaded = {name: load_json(EXAMPLES / name) for name in schema_for}
        schema_rejections = {
            "negative_revision_runtime_agreement.json", "negative_manifest_missing_agreement.json",
            "negative_manifest_reference_agreement.json", "negative_decision_missing_proposal.json",
        }
        for name, value in loaded.items():
            assert_jcs_values(value)
            if name in schema_rejections:
                try:
                    validate_instance(value, schema_for[name], "$", schema_for[name])
                except DesignError:
                    print(f"PASS expected schema rejection: {name}")
                else:
                    fail(f"{name}: negative fixture was unexpectedly accepted")
            else:
                validate_instance(value, schema_for[name], "$", schema_for[name])

        positive_revisions: dict[str, dict[str, Any]] = {}
        revision_names = (
            "document_revision_sales.json", "document_revision_fulfillment.json",
            "document_revision_settlement.json", "document_revision_review_invitation.json",
        )
        for name in revision_names:
            value = loaded[name]
            body = value["payload"]["body_markdown"]
            if "\r" in body:
                fail(f"{name}: body_markdown must use LF, not CR newlines")
            if len(body.encode("utf-8")) > 256 * 1024:
                fail(f"{name}: body_markdown exceeds 256 KiB UTF-8 limit")
            if len(jcs(value["payload"])) > 512 * 1024:
                fail(f"{name}: payload exceeds 512 KiB canonical JSON limit")
            expected = revision_digest(value["payload"])
            actual = require_digest(value["revision_digest"], f"{name}.revision_digest")
            if actual != expected:
                fail(f"{name}: digest mismatch (expected {expected}, got {actual})")
            positive_revisions[actual] = value["payload"]

        negative = loaded["negative_changed_body_old_digest.json"]
        negative_expected = revision_digest(negative["payload"])
        if negative["revision_digest"] == negative_expected:
            fail("negative_changed_body_old_digest.json: fixture no longer changes the digest")
        print("PASS expected rejection: negative_changed_body_old_digest.json (digest mismatch)")

        for name, payload in positive_revisions.items():
            for parent in payload["parents"]:
                if parent not in positive_revisions:
                    fail(f"{payload['revision_id']}: unknown parent digest {parent}")
                parent_payload = positive_revisions[parent]
                if any(parent_payload[k] != payload[k] for k in ("channel_id", "document_id", "context_id", "scope_id", "usage_scope")):
                    fail(f"{payload['revision_id']}: parent must share the immutable acceptance-slot tuple")
            for dependency in payload["dependencies"]:
                if dependency["revision_digest"] not in positive_revisions:
                    fail(f"{payload['revision_id']}: unknown dependency digest {dependency['revision_digest']}")
                target = positive_revisions[dependency["revision_digest"]]
                if any(dependency[k] != target[k] for k in ("context_id", "usage_scope", "document_id", "scope_id", "channel_id")) or target["channel_id"] != payload["channel_id"]:
                    fail(f"{payload['revision_id']}: dependency target context/scope does not match digest")

        def graph_depth(digest: str, edge: str, trail: tuple[str, ...] = ()) -> int:
            if digest in trail:
                fail(f"revision graph cycle at {digest}")
            if edge == "parents":
                refs = positive_revisions[digest]["parents"]
            else:
                refs = [d["revision_digest"] for d in positive_revisions[digest]["dependencies"]]
            return 1 + max((graph_depth(ref, edge, trail + (digest,)) for ref in refs), default=0)

        for digest in positive_revisions:
            graph_depth(digest, "parents")  # History is not capped at eight revisions.
            if graph_depth(digest, "dependencies") > 8:
                fail("dependency traversal depth exceeds 8")
        if len(positive_revisions) > 256:
            fail("fixture graph exceeds 256 unique revision nodes")

        policy = loaded["agreement_policy.json"]
        mapping_digest = next(digest for digest, payload in positive_revisions.items() if payload["revision_id"] == "rev-review-invitation-001")
        mapping = positive_revisions[mapping_digest]
        for field in ("context_id", "scope_id", "usage_scope", "channel_id", "document_id"):
            if policy[field] != mapping[field]:
                fail(f"agreement_policy: {field} does not bind mapping revision")
        representatives = {r["domain_role"]: r for r in policy["role_representatives"]}
        if len(representatives) != len(policy["role_representatives"]) or set(representatives) != set(policy["required_domain_roles"]):
            fail("policy must name exactly one representative per required role")
        if len({r["actor_id"] for r in representatives.values()}) != len(representatives):
            fail("fixture policy requires distinct human actors across roles")
        decisions = [loaded["approval_decision.json"], loaded["approval_decision_fulfillment.json"]]
        decision_by_id: dict[str, dict[str, Any]] = {}
        for decision in decisions:
            decision_revision = require_digest(decision["revision_digest"], f"{decision['decision_id']}.revision_digest")
            if decision_revision != mapping_digest:
                fail(f"{decision['decision_id']}: approval must bind the mapping digest")
            for field in ("document_id", "context_id", "scope_id", "usage_scope", "channel_id"):
                if decision[field] != mapping[field]:
                    fail(f"{decision['decision_id']}: {field} is stale relative to mapping")
            for field in ("policy_id", "policy_version", "membership_epoch", "role_binding_version"):
                if decision[field] != policy[field]:
                    fail(f"{decision['decision_id']}: {field} is stale relative to policy")
            if decision["actor_domain_role"] not in policy["required_domain_roles"]:
                fail(f"{decision['decision_id']}: actor role is not required by policy")
            representative = representatives[decision["actor_domain_role"]]
            if any(decision[k] != representative[k] for k in ("actor_org_id", "actor_id")):
                fail(f"{decision['decision_id']}: actor does not match policy representative")
            if decision["decision"] != "approve" or decision["decision"] not in policy["allowed_decisions"]:
                fail(f"{decision['decision_id']}: positive approval fixture must approve")
            if decision["decision_id"] in decision_by_id:
                fail("duplicate decision ID")
            decision_by_id[decision["decision_id"]] = decision
        if len({decision["proposal_id"] for decision in decisions}) != 1:
            fail("positive approvals must bind the same proposal")
        if {decision["actor_domain_role"] for decision in decisions} != set(policy["required_domain_roles"]):
            fail("approval decisions do not cover every required policy role")

        stale = loaded["negative_stale_decision_digest.json"]
        if stale["revision_digest"] in positive_revisions:
            fail("negative_stale_decision_digest.json: fixture unexpectedly names a current digest")
        print("PASS expected rejection: negative_stale_decision_digest.json (unknown revision digest)")

        manifest = loaded["run_context_manifest.json"]
        for field in ("context_id", "scope_id", "usage_scope", "policy_id", "policy_version", "membership_epoch"):
            if manifest[field] != policy[field]:
                fail(f"run_context_manifest: {field} is stale relative to policy")
        provided = {item["revision_digest"] for item in manifest["provided_revisions"]}
        if provided != set(positive_revisions):
            fail("run_context_manifest: provided_revisions must contain exactly all current revision digests")
        for item in manifest["provided_revisions"]:
            target = positive_revisions[item["revision_digest"]]
            for field in ("context_id", "scope_id", "usage_scope"):
                target_field = "target_" + field if field != "usage_scope" else field
                if item[target_field] != target[field]:
                    fail(f"run_context_manifest: provided reference {field} does not match digest")
            if item["reference_kind"] == "normative":
                if not item.get("agreement_id"):
                    fail("run_context_manifest: normative mapping reference needs its agreement_id")
        decision_refs = {item["decision_id"]: item["revision_digest"] for item in manifest["approval_decisions"]}
        if any(ref["proposal_id"] != decision_by_id.get(ref["decision_id"], {}).get("proposal_id") for ref in manifest["approval_decisions"]):
            fail("manifest decision reference has wrong proposal binding")
        if set(decision_refs) != set(decision_by_id):
            fail("run_context_manifest: decision references do not cover both approvals")
        if any(decision_refs[decision_id] != mapping_digest for decision_id in decision_by_id):
            fail("run_context_manifest: decision references do not bind the exact mapping digest")
        print(f"PASS {len(schemas)} schemas, {len(loaded)} examples, {len(positive_revisions)} digest-bound revisions")
        print("Restricted design-contract validation completed")
        return 0
    except DesignError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
