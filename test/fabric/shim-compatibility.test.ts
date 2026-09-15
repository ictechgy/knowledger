import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { FabricChaincode } from "../../packages/fabric/chaincode.ts";
import type { CoreEngine, FabricChaincodeConfig, FabricStub } from "../../packages/fabric/types.ts";

type ShimApi = {
  success(payload?: Uint8Array): { status: number; payload?: Uint8Array };
  error(message: string): { status: number; message: string };
  ChaincodeStub: new (
    client: unknown,
    channelId: string,
    txId: string,
    chaincodeInput: { getArgsList_asU8(): Uint8Array[] },
    signedProposal?: unknown,
  ) => { getArgs(): string[]; getBufferArgs(): Uint8Array[] };
};

const requireFromFabricPackage = createRequire(new URL("../../packages/fabric/package.json", import.meta.url));
let shim: ShimApi | undefined;
let fabricShimAvailable = false;
try {
  requireFromFabricPackage.resolve("fabric-shim");
  fabricShimAvailable = true;
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND" && error instanceof Error && error.message.includes("'fabric-shim'")) {
    // The root test suite deliberately has no Fabric runtime dependency.
  } else {
    throw error;
  }
}
if (fabricShimAvailable) {
  // Resolution succeeded, so any package initialization error must fail this test.
  shim = requireFromFabricPackage("fabric-shim") as ShimApi;
}

class OfficialShapeStub implements FabricStub {
  readonly state = new Map<string, Uint8Array>();
  args: Uint8Array[] = [];
  getCreator(): unknown { return { msp_id: "SalesMSP" }; }
  getTxID(): string { return "tx-official-shim"; }
  getChannelID(): string { return "kcl-demo"; }
  getArgs(): string[] { return this.args.map((arg) => new TextDecoder().decode(arg)); }
  getBufferArgs(): Uint8Array[] { return this.args; }
  getState(key: string): Promise<Uint8Array> { return Promise.resolve(this.state.get(key) ?? new Uint8Array()); }
  putState(key: string, value: Uint8Array): Promise<void> { this.state.set(key, value); return Promise.resolve(); }
}

function config(loadedShim: ShimApi): FabricChaincodeConfig {
  return {
    channel_id: "kcl-demo",
    public_genesis: { channel_id: "kcl-demo" },
    bootstrap_identity: { msp_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human" },
    registered_identities: [{ msp_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human" }],
    identity_decoder: () => ({ msp_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human" }),
    responses: {
      success: (payload) => loadedShim.success(payload),
      error: (message) => loadedShim.error(message),
    },
  };
}

test("matches fabric-shim 2.5.8 string arguments and response payloads", { skip: !shim }, async () => {
  assert.ok(shim);
  const officialInput = {
    getArgsList_asU8: () => [
      new TextEncoder().encode("Execute"),
      new TextEncoder().encode(JSON.stringify({ command_id: "cmd-shim", type: "fence", input: {} })),
    ],
  };
  const officialStub = new shim.ChaincodeStub(null, "kcl-demo", "tx-official-shim", officialInput);
  assert.deepEqual(officialStub.getArgs(), [
    "Execute",
    JSON.stringify({ command_id: "cmd-shim", type: "fence", input: {} }),
  ]);
  assert.equal(officialStub.getArgs().every((argument) => typeof argument === "string"), true);
  assert.deepEqual(officialStub.getBufferArgs().map((argument) => Array.from(argument)), [
    Array.from(new TextEncoder().encode("Execute")),
    Array.from(new TextEncoder().encode(JSON.stringify({ command_id: "cmd-shim", type: "fence", input: {} }))),
  ]);

  const core: CoreEngine = {
    bootstrap: async () => ({}),
    execute: async (_ctx, command) => ({ command_id: command.command_id }),
  };
  const chaincode = new FabricChaincode(core, config(shim));
  const stub = new OfficialShapeStub();
  stub.args = officialStub.getBufferArgs().slice(1);

  const response = await chaincode.Invoke(stub) as { status: number; payload?: Uint8Array; message?: string };
  assert.equal(response.status, 200, response.message);
  assert.ok(response.payload);
  assert.equal(response.payload instanceof Uint8Array, true);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.payload)), {
    status: "executed",
    result: { command_id: "cmd-shim" },
  });

  let executed = false;
  const malformedCommand = Uint8Array.from([
    ...new TextEncoder().encode('{"command_id":"cmd-malformed","type":"fence","input":{"note":"'),
    0xff,
    ...new TextEncoder().encode('"}}'),
  ]);
  const malformedInput = {
    getArgsList_asU8: () => [new TextEncoder().encode("Execute"), malformedCommand],
  };
  const malformedOfficialStub = new shim.ChaincodeStub(null, "kcl-demo", "tx-malformed", malformedInput);
  assert.equal(malformedOfficialStub.getArgs()[1].includes("\uFFFD"), true);
  assert.deepEqual(Array.from(malformedOfficialStub.getBufferArgs()[1]), Array.from(malformedCommand));
  const malformedStub = new OfficialShapeStub();
  malformedStub.args = malformedOfficialStub.getBufferArgs().slice(1);
  const malformedChaincode = new FabricChaincode({
    bootstrap: async () => ({}),
    execute: async () => { executed = true; return {}; },
  }, config(shim));
  const malformedResponse = await malformedChaincode.Invoke(malformedStub) as { status: number };
  assert.equal(malformedResponse.status, 500);
  assert.equal(executed, false);
});
