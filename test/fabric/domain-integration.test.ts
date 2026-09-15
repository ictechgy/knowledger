import test from "node:test";
import assert from "node:assert/strict";
import { demoFixtures } from "../../examples/order-workflow/config.ts";
import { bootstrap, execute } from "../../packages/domain/index.ts";
import { FabricChaincode } from "../../packages/fabric/chaincode.ts";
import type { FabricChaincodeConfig, FabricStub } from "../../packages/fabric/types.ts";

class LedgerStub implements FabricStub {
  args: Uint8Array[] = [];
  readonly state: Map<string, Uint8Array>;
  readonly creator: unknown;
  readonly tx_id: string;
  constructor(state: Map<string, Uint8Array>, creator: unknown, tx_id: string) { this.state = state; this.creator = creator; this.tx_id = tx_id; }
  getCreator(): unknown { return this.creator; }
  getTxID(): string { return this.tx_id; }
  getChannelID(): string { return "kcl-demo"; }
  getArgs(): string[] { return this.args.map((arg) => new TextDecoder().decode(arg)); }
  getBufferArgs(): Uint8Array[] { return this.args; }
  getState(key: string): Promise<Uint8Array> { return Promise.resolve(this.state.get(key) ?? new Uint8Array()); }
  putState(key: string, value: Uint8Array): Promise<void> { this.state.set(key, value); return Promise.resolve(); }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function creator(org_id: string, actor_id: string, kind = "human") {
  return { msp_id: org_id, attrs: { "kcl.actor_id": actor_id, "kcl.actor_kind": kind } };
}

test("Fabric shim boundary executes real core through activate", async () => {
  const fixtures = demoFixtures();
  const state = new Map<string, Uint8Array>();
  const config: FabricChaincodeConfig = {
    channel_id: "kcl-demo",
    public_genesis: fixtures.config,
    bootstrap_identity: { msp_id: "FulfillmentMSP", actor_id: "person-fulfillment-owner", actor_kind: "human" },
    registered_identities: fixtures.config.identities.map((identity) => ({ msp_id: identity.org_id, actor_id: identity.actor_id, actor_kind: identity.kind })),
    identity_decoder: (raw) => {
      const value = raw as ReturnType<typeof creator>;
      return { msp_id: value.msp_id, actor_id: value.attrs["kcl.actor_id"], actor_kind: value.attrs["kcl.actor_kind"] as "human" | "agent" };
    },
    responses: { success: (payload) => ({ status: 200, payload }), error: (message) => ({ status: 500, message }) },
  };
  const chaincode = new FabricChaincode({ bootstrap, execute }, config);
  let transaction = 0;
  async function invoke(org_id: string, actor_id: string, command: { command_id: string; type: string; input: unknown }): Promise<any> {
    const stub = new LedgerStub(state, creator(org_id, actor_id), `tx-${++transaction}`);
    stub.args = [encoder.encode("Execute"), encoder.encode(JSON.stringify(command))];
    const response = await chaincode.Invoke(stub) as { status: number; payload?: Uint8Array; message?: string };
    assert.equal(response.status, 200, response.message);
    return JSON.parse(decoder.decode(response.payload));
  }
  const init = new LedgerStub(state, creator("FulfillmentMSP", "person-fulfillment-owner"), "tx-init");
  init.args = [encoder.encode("Init")];
  assert.equal((await chaincode.Init(init) as { status: number }).status, 200);

  const personas = [
    ["SalesMSP", "person-sales-owner"],
    ["FulfillmentMSP", "person-fulfillment-owner"],
    ["SettlementMSP", "person-settlement-owner"],
    ["FulfillmentMSP", "person-fulfillment-owner"],
  ] as const;
  const roleNames = ["sales_owner", "fulfillment_owner", "settlement_owner", "fulfillment_owner"] as const;
  for (const [index, revision] of fixtures.revisions.entries()) {
    const [org_id, actor_id] = personas[index];
    const policy = fixtures.policies[index];
    await invoke(org_id, actor_id, {
      command_id: `publish-${index}`,
      type: "publish_revision",
      input: { revision, publication: { revision_digest: revision.revision_digest, config_version: 1, membership_epoch: 1 } },
    });
    const proposal_id = `proposal-${index}`;
    await invoke(org_id, actor_id, { command_id: `propose-${index}`, type: "propose", input: { proposal_id, revision_digest: revision.revision_digest, policy_id: policy.policy_id, policy_version: 1 } });
    const representatives = index === 3
      ? [["FulfillmentMSP", "person-fulfillment-owner", "fulfillment_owner"], ["SettlementMSP", "person-settlement-owner", "settlement_owner"]] as const
      : [[org_id, actor_id, roleNames[index]]] as const;
    for (const [decisionIndex, [decisionOrg, decisionActor, decisionRole]] of representatives.entries()) {
      const decision = {
        contract_type: "ApprovalDecision", contract_version: 1, decision_id: `decision-${index}-${decisionIndex}`,
        revision_digest: revision.revision_digest, document_id: revision.payload.document_id, context_id: revision.payload.context_id,
        scope_id: revision.payload.scope_id, usage_scope: revision.payload.usage_scope, channel_id: "kcl-demo",
        policy_id: policy.policy_id, policy_version: 1, membership_epoch: 1, role_binding_version: 1,
        actor_org_id: decisionOrg, actor_id: decisionActor, subject_id: `subject-${index}`, actor_domain_role: decisionRole, decision: "approve",
        rationale: "approved in integration fixture", decided_at: "2026-09-15T00:00:00Z", proposal_id,
      };
      await invoke(decisionOrg, decisionActor, { command_id: `decide-${index}-${decisionIndex}`, type: "decide", input: { decision } });
    }
    const [activateOrg, activateActor] = index === 3 ? ["SettlementMSP", "person-settlement-owner"] : [org_id, actor_id];
    const activated = await invoke(activateOrg, activateActor, { command_id: `activate-${index}`, type: "activate", input: { proposal_id, agreement_id: `agreement-${index}`, expected_active_agreement_id: null } });
    assert.equal(activated.result.status, "active");
  }
  assert.equal(state.size > 20, true);
});
