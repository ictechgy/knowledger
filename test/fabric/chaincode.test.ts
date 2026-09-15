import test from "node:test";
import assert from "node:assert/strict";
import { FabricChaincode } from "../../packages/fabric/chaincode.ts";
import type { CoreEngine, FabricChaincodeConfig, FabricStub } from "../../packages/fabric/types.ts";

class FakeStub implements FabricStub {
  readonly state = new Map<string, Uint8Array>();
  args: Uint8Array[] = [];
  readonly creator: unknown;
  readonly tx_id: string;
  readonly channel: string;
  constructor(creator: unknown, tx_id: string, channel = "kcl-demo") { this.creator = creator; this.tx_id = tx_id; this.channel = channel; }
  getCreator(): unknown { return this.creator; }
  getTxID(): string { return this.tx_id; }
  getChannelID(): string { return this.channel; }
  getArgs(): string[] { return this.args.map((arg) => new TextDecoder().decode(arg)); }
  getBufferArgs(): Uint8Array[] { return this.args; }
  getState(key: string): Promise<Uint8Array> { return Promise.resolve(this.state.get(key) ?? new Uint8Array()); }
  putState(key: string, value: Uint8Array): Promise<void> { this.state.set(key, value); return Promise.resolve(); }
}

const actor = { msp_id: "SalesMSP", attrs: { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" } };
const genesis = { channel_id: "kcl-demo", policy_version: 1, public: true };

function responseConfig(): Pick<FabricChaincodeConfig, "responses"> {
  return { responses: {
    success: (payload) => ({ status: 200, payload }),
    error: (message) => ({ status: 500, message }),
  } };
}

function config(overrides: Partial<FabricChaincodeConfig> = {}): FabricChaincodeConfig {
  return {
    channel_id: "kcl-demo",
    public_genesis: genesis,
    bootstrap_identity: { msp_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human" },
    identity_decoder: (creator) => {
      const value = creator as { msp_id: string; attrs: Record<string, string> };
      return { msp_id: value.msp_id, actor_id: value.attrs["kcl.actor_id"], actor_kind: value.attrs["kcl.actor_kind"] as "human" | "agent" };
    },
    registered_identities: [{ msp_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human" }],
    ...responseConfig(),
    ...overrides,
  };
}

test("bootstrap is pinned to the packaged founder and rejects arbitrary input", async () => {
  const calls: string[] = [];
  const core: CoreEngine = {
    bootstrap: async (ctx, value) => { calls.push("bootstrap"); await ctx.put("kcl:config:genesis", value); return { ok: true }; },
    execute: async () => ({ ok: true }),
  };
  const chaincode = new FabricChaincode(core, config());
  const wrong = new FakeStub({ msp_id: "SettlementMSP", attrs: { "kcl.actor_id": "person-settlement-owner", "kcl.actor_kind": "human" } }, "tx-wrong");
  const rejected = await chaincode.Init(wrong) as { status: number };
  assert.equal(rejected.status, 500);
  assert.deepEqual(calls, []);

  const founder = new FakeStub(actor, "tx-init");
  founder.args = [new TextEncoder().encode("attacker-genesis")];
  const inputRejected = await chaincode.Init(founder) as { status: number };
  assert.equal(inputRejected.status, 500);
  assert.deepEqual(calls, []);

  const valid = new FakeStub(actor, "tx-valid-init");
  valid.args = [new TextEncoder().encode("Init")];
  const bootstrapped = await chaincode.Init(valid) as { status: number };
  assert.equal(bootstrapped.status, 200);
  assert.deepEqual(calls, ["bootstrap"]);
  const retry = await chaincode.Init(valid) as { status: number };
  assert.equal(retry.status, 200);
  assert.deepEqual(calls, ["bootstrap"]);
});

test("identity attributes control actor and buffered writes are read-your-writes", async () => {
  const core: CoreEngine = {
    bootstrap: async () => ({}),
    execute: async (ctx, command) => {
      await ctx.put("kcl:revision:one", { command_id: command.command_id });
      return { before_flush: (await ctx.get("kcl:revision:one")) ?? null };
    },
  };
  const chaincode = new FabricChaincode(core, config());
  const spoof = new FakeStub(actor, "tx-spoof");
  spoof.args = [new TextEncoder().encode(JSON.stringify({ command_id: "cmd-1", type: "decide", input: { actor_id: "person-settlement-owner" } }))];
  const rejected = await chaincode.Invoke(spoof) as { status: number };
  assert.equal(rejected.status, 500);
  assert.equal(spoof.state.size, 0);

  const valid = new FakeStub(actor, "tx-command");
  valid.args = [new TextEncoder().encode(JSON.stringify({ command_id: "cmd-1", type: "decide", input: { actor_id: "person-sales-owner" } }))];
  const committed = await chaincode.Invoke(valid) as { status: number; payload: Uint8Array };
  assert.equal(committed.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(committed.payload)).result.before_flush, { command_id: "cmd-1" });
  assert.equal(valid.state.has("kcl:revision:one"), true);
  const second = await chaincode.Invoke(valid) as { status: number };
  assert.equal(second.status, 200);
  valid.state.set("kcl:v1:idempotency:SalesMSP:cmd-1", new TextEncoder().encode('{"command_id":"cmd-1","actor":{"org_id":"SalesMSP","actor_id":"person-sales-owner","kind":"human"},"result":{"ok":true}}'));
  const get = new FakeStub(actor, "tx-get");
  for (const [key, value] of valid.state) get.state.set(key, value);
  get.args = [new TextEncoder().encode("GetCommand"), new TextEncoder().encode("SalesMSP"), new TextEncoder().encode("cmd-1")];
  const commandRecord = await chaincode.Invoke(get) as { status: number; payload: Uint8Array };
  assert.equal(commandRecord.status, 200);
  assert.equal(commandRecord.payload.byteLength > 0, true);
  get.state.set("kcl:v1:idempotency:SalesMSP:other", new TextEncoder().encode('{"command_id":"other","actor":{"org_id":"SalesMSP","actor_id":"person-other","kind":"human"},"result":{"ok":true}}'));
  get.args = [new TextEncoder().encode("GetCommand"), new TextEncoder().encode("SalesMSP"), new TextEncoder().encode("other")];
  const actorMismatch = await chaincode.Invoke(get) as { status: number };
  assert.equal(actorMismatch.status, 500);
  get.args = [new TextEncoder().encode("GetCommand"), new TextEncoder().encode("SettlementMSP"), new TextEncoder().encode("cmd-1")];
  const crossOrg = await chaincode.Invoke(get) as { status: number };
  assert.equal(crossOrg.status, 500);
});

test("duplicate command JSON keys are rejected before core execution", async () => {
  let executed = false;
  const core: CoreEngine = {
    bootstrap: async () => ({}),
    execute: async () => { executed = true; return {}; },
  };
  const chaincode = new FabricChaincode(core, config());
  const stub = new FakeStub(actor, "tx-duplicate");
  stub.args = [new TextEncoder().encode('{"command_id":"one","command_id":"two","type":"fence","input":{}}')];
  const result = await chaincode.Invoke(stub) as { status: number };
  assert.equal(result.status, 500);
  assert.equal(executed, false);
});
