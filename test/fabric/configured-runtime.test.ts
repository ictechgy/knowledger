import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { configuredOutboxFile, createConfiguredFabricRuntime } from "../../apps/api/configured-fabric-runtime.ts";
import { signingAttestationConfig } from "../../packages/fabric/gateway.ts";

test("configured outbox filenames use a full hash of the actor binding", () => {
  const expected = createHash("sha256").update(JSON.stringify(["OrgA", "actor-1"]), "utf8").digest("hex");
  assert.equal(configuredOutboxFile("OrgA", "actor-1"), `outbox-${expected}.sqlite`);
  assert.equal(configuredOutboxFile("OrgA", "actor-1").length, "outbox-".length + 64 + ".sqlite".length);
});

test("configured runtime rejects a non-Fabric configuration before loading credentials", async () => {
  const configuration = {
    ledger: { mode: "local-simulation", channel_id: "workspace" },
    genesis: { channel_id: "workspace" },
  } as never;
  await assert.rejects(() => createConfiguredFabricRuntime(configuration, {
    dataDir: "/tmp/knowledger-configured-runtime-test",
    organization: "OrgA",
    authorizeActor: async () => undefined,
  }), /Fabric ledger configuration is required/);
});

test("example runtime installs attestation wiring only when a signerProvider consumes it", () => {
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" as const };
  // The raw in-process fallback signs nothing into evidence: installing an
  // attestation would fail closed on every signed call, so the gateway must
  // run unattested when no provider is configured.
  assert.equal(signingAttestationConfig(actor, {}, false), undefined);
  const context = {};
  const config = signingAttestationConfig(actor, context, true);
  assert.equal(config?.context, context);
  assert.equal(config?.buildQuery().phase, "query");
});
