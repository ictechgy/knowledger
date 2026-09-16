import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { CONFIGURATION_SCOPE_FILE, ensureConfigurationScope, readConfigurationScope, type ConfiguredRuntimeBinding } from "../../packages/storage/configuration-scope.ts";

function binding(organization?: string): ConfiguredRuntimeBinding {
  return {
    version: 1,
    workspace_id: "workspace-open-source",
    channel_id: "channel-generic",
    mode: organization ? "fabric" : "local-simulation",
    authority_digest: "sha256:" + "a".repeat(64),
    ...(organization ? { organization } : {}),
    databases: organization ? ["private-local.sqlite", "fabric-projection.sqlite", ...Array.from({ length: 4 }, (_, index) => `outbox-${String(index + 1).padStart(64, "0")}.sqlite`)] : ["private-local.sqlite", "shared-ledger.sqlite"],
  };
}

test("configuration scope binds generic local and selected-organization Fabric data", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledger-config-scope-"));
  try {
    const local = join(root, "local");
    ensureConfigurationScope(local, binding());
    assert.deepEqual(readConfigurationScope(local), binding());
    assert.equal(lstatSync(join(local, CONFIGURATION_SCOPE_FILE)).mode & 0o777, 0o600);
    assert.doesNotThrow(() => ensureConfigurationScope(local, binding()));

    const fabric = join(root, "fabric");
    const selected = binding("OrgFour");
    ensureConfigurationScope(fabric, selected);
    assert.equal(readConfigurationScope(fabric)?.organization, "OrgFour");
    assert.throws(() => ensureConfigurationScope(fabric, { ...selected, organization: "OrgTwo" }), /binding|organization|differs/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("configuration scope never adopts legacy files or malformed authority bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledger-config-scope-invalid-"));
  try {
    const directory = join(root, "legacy");
    ensureConfigurationScope(directory, binding());
    const existing = join(root, "nonempty");
    mkdirSync(existing, { mode: 0o700 });
    writeFileSync(join(existing, "private-local.sqlite"), "legacy", { mode: 0o600 });
    assert.throws(() => ensureConfigurationScope(existing, binding()), /legacy|empty|adopt/i);
    const malformed = join(root, "malformed");
    mkdirSync(malformed, { mode: 0o700 });
    writeFileSync(join(malformed, CONFIGURATION_SCOPE_FILE), JSON.stringify({ ...binding(), authority_digest: "sha256:bad" }), { mode: 0o600 });
    assert.throws(() => ensureConfigurationScope(malformed, binding()), /digest|binding|invalid/i);
    assert.equal(existsSync(join(directory, CONFIGURATION_SCOPE_FILE)), true);
    assert.equal(readFileSync(join(directory, CONFIGURATION_SCOPE_FILE), "utf8").includes("Org"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
