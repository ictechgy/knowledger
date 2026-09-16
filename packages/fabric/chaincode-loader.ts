import type { FabricChaincode } from "./chaincode.ts";
import type { FabricResponseFactory, FabricStub, IdentityDecoder } from "./types.ts";
import type { ChaincodeInterface, ChaincodeResponse, ChaincodeStub } from "fabric-shim";
import { createRequire } from 'node:module';

interface ShimModule {
  start(chaincode: ChaincodeInterface): Promise<void> | void;
  success(payload?: Uint8Array): ChaincodeResponse;
  error(message: string): ChaincodeResponse;
  ClientIdentity: new (stub: ChaincodeStub) => {
    getMSPID(): string;
    getAttributeValue(name: string): string | null;
  };
}

async function loadShim(): Promise<ShimModule> {
  // The official shim is CommonJS. Load it only when starting a real peer connection.
  return createRequire(import.meta.url)('fabric-shim') as ShimModule;
}

export async function startFabricChaincode(factory: (responses: FabricResponseFactory, identityDecoder: IdentityDecoder) => FabricChaincode): Promise<void> {
  const shim = await loadShim();
  const identityDecoder: IdentityDecoder = (_creator, stub) => {
    const identity = new shim.ClientIdentity(stub as unknown as ChaincodeStub);
    const msp_id = identity.getMSPID();
    const actor_id = identity.getAttributeValue("kcl.actor_id");
    const actor_kind = identity.getAttributeValue("kcl.actor_kind");
    if (!msp_id || !actor_id || (actor_kind !== "human" && actor_kind !== "agent")) throw new Error("required Knowledger certificate attributes missing");
    return { msp_id, actor_id, actor_kind };
  };
  const chaincode = factory({
    success: (payload) => shim.success(payload),
    error: (message) => shim.error(message),
  }, identityDecoder);
  await shim.start({
    Init: (stub) => chaincode.Init(stub as unknown as FabricStub),
    Invoke: (stub) => chaincode.Invoke(stub as unknown as FabricStub),
  });
}
