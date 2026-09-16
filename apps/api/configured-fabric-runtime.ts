import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import type { Actor } from "../../packages/storage/local-ledger.ts";
import type { FabricWritePhase } from "../../packages/fabric/gateway.ts";
import { createRemoteSigner } from "../../packages/fabric/remote-signer.ts";
import { connectOfficialFabricGateway, FabricGatewayTransport, fabricPeerChannelOptions } from "../../packages/fabric/gateway.ts";
import type { FabricSigningRoute } from "../../packages/fabric/application-ledger.ts";
import { FabricApplicationLedger } from "../../packages/fabric/application-ledger.ts";
import type { SqliteFabricProjection } from "../../packages/fabric/sqlite-projection.ts";
import { SqliteOutbox } from "../../packages/fabric/sqlite-outbox.ts";
import type { Persona, ProjectConfiguration, FabricIdentityConfiguration } from "../../packages/config/types.ts";

const requireFabric = createRequire(new URL("../../packages/fabric/package.json", import.meta.url));

export function configuredOutboxFile(orgId: string, actorId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([orgId, actorId]), "utf8").digest("hex");
  return `outbox-${digest}.sqlite`;
}

function configuredIdentity(configuration: ProjectConfiguration, reference: FabricIdentityConfiguration): Actor {
  const identity = configuration.genesis.identities.find((candidate) => candidate.org_id === reference.org_id && candidate.actor_id === reference.actor_id);
  if (!identity) throw new Error("Fabric identity is not registered in genesis");
  return { org_id: identity.org_id, actor_id: identity.actor_id, kind: identity.kind };
}

function readCertificate(reference: FabricIdentityConfiguration): Buffer {
  if (!isAbsolute(reference.certificate_path)) throw new Error("Fabric certificate path must be absolute");
  const certificate = readFileSync(reference.certificate_path);
  if (certificate.byteLength === 0 || certificate.byteLength > 16 * 1024) throw new Error("Fabric certificate is outside the supported size");
  const parsed = new X509Certificate(certificate);
  const validFrom = Date.parse(parsed.validFrom);
  const validTo = Date.parse(parsed.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || Date.now() < validFrom || Date.now() > validTo) throw new Error("Fabric certificate is outside its validity period");
  return certificate;
}

function assertIdentityAttributes(certificate: Uint8Array, actor: Actor, channelId: string): void {
  const { ClientIdentity } = requireFabric("fabric-shim") as { ClientIdentity: new (stub: unknown) => { getMSPID(): string; getAttributeValue(name: string): string | null } };
  const identity = new ClientIdentity({ getCreator: () => ({ mspid: actor.org_id, idBytes: certificate }), getChannelID: () => channelId, getTxID: () => "configured-runtime-validation" });
  if (identity.getMSPID() !== actor.org_id || identity.getAttributeValue("kcl.actor_id") !== actor.actor_id || identity.getAttributeValue("kcl.actor_kind") !== actor.kind) {
    throw new Error("Fabric certificate attributes do not match configured identity");
  }
}

function configuredReferences(configuration: ProjectConfiguration, organization: string): FabricIdentityConfiguration[] {
  if (!configuration.fabric || !Array.isArray(configuration.fabric.identities) || configuration.fabric.identities.length === 0) throw new Error("Fabric identity configuration is required");
  const selected = configuration.fabric.identities.filter((reference) => reference.org_id === organization);
  if (selected.length === 0) throw new Error("Selected organization has no Fabric identities");
  if (selected.some((reference) => !isAbsolute(reference.certificate_path) || !isAbsolute(reference.tls_ca_path) || !isAbsolute(reference.signer_socket_path))) throw new Error("Fabric paths must be absolute");
  const actors = selected.map((reference) => configuredIdentity(configuration, reference));
  if (new Set(actors.map((actor) => JSON.stringify(actor))).size !== actors.length) throw new Error("Fabric identity configuration contains duplicate actors");
  return selected;
}

export async function createConfiguredFabricRuntime(configuration: ProjectConfiguration, options: {
  dataDir: string;
  organization: string;
  authorizeActor: (actor: Actor, phase: FabricWritePhase) => Promise<void>;
}): Promise<{ ledger: FabricApplicationLedger; personas: Persona[] }> {
  if (configuration.ledger.mode !== "fabric" || !configuration.fabric) throw new Error("Fabric ledger configuration is required");
  if (configuration.ledger.channel_id !== configuration.genesis.channel_id) throw new Error("Fabric channel differs from genesis");
  const references = configuredReferences(configuration, options.organization);
  const { SqliteFabricProjection } = await import("../../packages/fabric/sqlite-projection.ts");
  const require = requireFabric;
  const grpc = require("@grpc/grpc-js") as { Client: new (target: string, credentials: unknown, options?: Record<string, string | number>) => { close(): void }; credentials: { createSsl(certificate: Uint8Array): unknown } };
  const sdk = require("@hyperledger/fabric-gateway") as { connect(options: Record<string, unknown>): { close(): void; getNetwork(channelId: string): { getContract(name: string): { evaluateTransaction(name: string, ...args: string[]): Promise<Uint8Array> } } } };
  const { common } = require("@hyperledger/fabric-protos") as { common: { BlockchainInfo: { deserializeBinary(bytes: Uint8Array): { getHeight(): number; getCurrentblockhash_asU8(): Uint8Array } } } };
  const routes: FabricSigningRoute[] = [];
  const gateways: Array<{ close(): void; getNetwork(channelId: string): { getContract(name: string): { evaluateTransaction(name: string, ...args: string[]): Promise<Uint8Array> } } }> = [];
  let projection: SqliteFabricProjection | undefined;
  try {
    for (const reference of references) {
      const actor = configuredIdentity(configuration, reference);
      const certificate = readCertificate(reference);
      assertIdentityAttributes(certificate, actor, configuration.ledger.channel_id);
      const tlsCertificate = readFileSync(reference.tls_ca_path);
      const signer = createRemoteSigner({ socketPath: reference.signer_socket_path, keyId: reference.key_id, certificate });
      const rpc = new grpc.Client(reference.peer_endpoint, grpc.credentials.createSsl(tlsCertificate), {
        "grpc.ssl_target_name_override": reference.peer_host_alias,
        "grpc.default_authority": reference.peer_host_alias,
        ...fabricPeerChannelOptions,
      });
      let client: Awaited<ReturnType<typeof connectOfficialFabricGateway>> | undefined;
      let gateway: ReturnType<typeof sdk.connect> | undefined;
      let outbox: SqliteOutbox | undefined;
      try {
        client = await connectOfficialFabricGateway({ client: rpc, channel_id: configuration.ledger.channel_id, chaincode_name: configuration.fabric.chaincode_name, credentials: { msp_id: actor.org_id, certificate, signer }, authorize: phase => options.authorizeActor(actor, phase) });
        gateway = sdk.connect({ client: rpc, identity: { mspId: actor.org_id, credentials: certificate }, signer, evaluateOptions: () => ({ deadline: Date.now() + 5000 }), endorseOptions: () => ({ deadline: Date.now() + 5000 }), submitOptions: () => ({ deadline: Date.now() + 5000 }), commitStatusOptions: () => ({ deadline: Date.now() + 5000 }) });
        outbox = new SqliteOutbox(join(options.dataDir, configuredOutboxFile(actor.org_id, actor.actor_id)));
        const opened = { client, gateway, outbox, rpc };
        routes.push({ actor, transport: new FabricGatewayTransport({ client, outbox }), close() { opened.outbox.close(); opened.client.close?.(); opened.gateway.close(); opened.rpc.close(); } });
        gateways.push(gateway);
      } catch (error) { outbox?.close(); client?.close?.(); gateway?.close(); rpc.close(); throw error; }
    }
    projection = new SqliteFabricProjection(join(options.dataDir, "fabric-projection.sqlite"), { channel_id: configuration.ledger.channel_id, chaincode_name: configuration.fabric.chaincode_name, chaincode_version: configuration.fabric.chaincode_version, public_genesis: configuration.genesis });
    const qscc = gateways[0].getNetwork(configuration.ledger.channel_id).getContract("qscc");
    const ledger = new FabricApplicationLedger({ mode: 'fabric', projection, routes, source: {
      async getTip() {
        const bytes = await qscc.evaluateTransaction("GetChainInfo", configuration.ledger.channel_id);
        const info = common.BlockchainInfo.deserializeBinary(bytes);
        return { height: info.getHeight(), block_hash: Buffer.from(info.getCurrentblockhash_asU8()).toString("hex") };
      },
      getBlock: number => qscc.evaluateTransaction("GetBlockByNumber", configuration.ledger.channel_id, String(number)),
    } });
    await ledger.recoverPending();
    const labels = new Map(configuration.identities.map((identity) => [`${identity.org_id}|${identity.actor_id}`, identity.label]));
    const personas = configuration.genesis.identities.filter((identity) => identity.kind === "human" && identity.org_id === options.organization).map((identity) => ({ ...identity, label: labels.get(`${identity.org_id}|${identity.actor_id}`) ?? identity.actor_id }));
    return { ledger, personas };
  } catch (error) {
    for (const route of routes) await route.close?.();
    projection?.close();
    throw error;
  }
}
