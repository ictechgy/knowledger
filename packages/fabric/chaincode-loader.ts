import type { FabricChaincode } from "./chaincode.ts";
import type { FabricResponseFactory, FabricStub, IdentityDecoder } from "./types.ts";
import { createRequire } from 'node:module';

interface ShimModule {
  start(chaincode: FabricChaincode): Promise<void> | void;
  success(payload: Uint8Array): unknown;
  error(message: string): unknown;
  ClientIdentity: new (stub: FabricStub) => {
    getMSPID(): string;
    getAttributeValue(name: string): string | undefined;
  };
}

async function loadShim(): Promise<ShimModule> {
  // The official shim is CommonJS. Load it only when starting a real peer connection.
  return createRequire(import.meta.url)('fabric-shim') as ShimModule;
}

export async function startFabricChaincode(factory: (responses: FabricResponseFactory, identityDecoder: IdentityDecoder) => FabricChaincode): Promise<void> {
  const shim = await loadShim();
  const identityDecoder: IdentityDecoder = (_creator, stub) => {
    const identity = new shim.ClientIdentity(stub);
    const msp_id = identity.getMSPID();
    const actor_id = identity.getAttributeValue("kcl.actor_id");
    const actor_kind = identity.getAttributeValue("kcl.actor_kind");
    if (!msp_id || !actor_id || (actor_kind !== "human" && actor_kind !== "agent")) throw new Error("required KCL certificate attributes missing");
    return { msp_id, actor_id, actor_kind };
  };
  await shim.start(factory({
    success: (payload) => shim.success(payload),
    error: (message) => shim.error(message),
  }, identityDecoder));
}
