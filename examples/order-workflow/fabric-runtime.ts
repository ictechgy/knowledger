/** Loopback integration profile. These fictional identities are not production authentication. */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PERSONAS, actorIdentity, demoFixtures } from './config.ts';
import { DEVELOPMENT_ORGANIZATIONS, getDevelopmentOrganization } from './organizations.ts';
import type { DevelopmentOrganization } from './organizations.ts';
import { ensureRuntimeScope } from '../../packages/storage/runtime-scope.ts';
import { SqliteFabricProjection } from '../../packages/fabric/sqlite-projection.ts';
import { connectOfficialFabricGateway, decisionAttestation, FabricGatewayTransport, fabricPeerChannelOptions, queryAttestation } from '../../packages/fabric/gateway.ts';
import type { FabricWritePhase, GatewayAttestation } from '../../packages/fabric/gateway.ts';
import type { AttestationSerializer, SigningAttestationContext } from '../../packages/fabric/remote-signer.ts';
import { closeAllResources, createAttestationSerializer, releaseAttestationSerializer } from '../../packages/fabric/remote-signer.ts';
import { FabricApplicationLedger } from '../../packages/fabric/application-ledger.ts';
import type { FabricSigningRoute } from '../../packages/fabric/application-ledger.ts';
import { SqliteOutbox } from '../../packages/fabric/sqlite-outbox.ts';
import type { Actor } from '../../packages/storage/local-ledger.ts';

function closeAll(cleanups: ReadonlyArray<() => void>): void {
  closeAllResources(cleanups, "fabric runtime cleanup failed");
}

/**
 * Attestation wiring exists only when a signerProvider consumes the slot:
 * the raw in-process fallback signs nothing into evidence, so installing
 * attestations would fail closed on every signed call.
 */
export function signingAttestationConfig(actor: Actor, context: SigningAttestationContext, signerProvider: FabricTestRuntimeOptions['signerProvider']): GatewayAttestation | undefined {
  if (signerProvider === undefined) return undefined;
  return { context, build: (command, phase, txId) => decisionAttestation(actor, command, phase, txId), buildQuery: () => queryAttestation(actor) };
}

export interface FabricTestRuntimeOptions {
  organization?: DevelopmentOrganization;
  /** Remote signer factory; the attestation slot is required because development keys all demand attested signing. Omitting it falls back to raw in-process key signing for the unauthenticated fixture only — that path consumes no attestation slot and produces no service-side evidence. */
  signerProvider?: (actor: Actor, certificate: Uint8Array, attestation: SigningAttestationContext) => (digest: Uint8Array) => Promise<Uint8Array>;
  authorizeActor?: (actor: Actor, phase: FabricWritePhase) => Promise<void>;
}

export async function createFabricTestRuntime(dataDir: string, options: FabricTestRuntimeOptions = {}) {
  const organization = options.organization === undefined ? undefined : getDevelopmentOrganization(options.organization);
  ensureRuntimeScope(dataDir, organization);
  const require = createRequire(new URL('../../packages/fabric/package.json', import.meta.url));
  const grpc = require('@grpc/grpc-js');
  const sdk = require('@hyperledger/fabric-gateway');
  const { common } = require('@hyperledger/fabric-protos');
  const { ClientIdentity } = require('fabric-shim');
  const cryptoRoot = fileURLToPath(new URL('../../.data/fabric-smoke/crypto/peerOrganizations/', import.meta.url));
  const routes: FabricSigningRoute[] = [];
  const qsccGateways: Array<{ actor: Actor; gateway: any; signed: AttestationSerializer }> = [];
  let projection: SqliteFabricProjection | undefined;
  try {
    const selectedOrganizations = organization ? [organization] : DEVELOPMENT_ORGANIZATIONS;
    for (const selected of selectedOrganizations) {
      const persona = PERSONAS.find(candidate => candidate.actor_id === selected.key_id && candidate.org_id === selected.org_id && candidate.kind === 'human');
      if (!persona) throw new Error('Development organization has no human signing persona');
      const actor = actorIdentity(persona);
      const domain = `${selected.domain}.kcl.test`;
      const base = join(cryptoRoot, domain);
      const msp = join(base, 'users', `User1@${domain}`, 'msp');
      const certificate = readFileSync(join(msp, 'signcerts', `User1@${domain}-cert.pem`));
      const parsed = new X509Certificate(certificate);
      if (Date.parse(parsed.validFrom) > Date.now() || Date.parse(parsed.validTo) <= Date.now()) throw new Error('Test enrollment certificate is outside its validity period');
      const attestationContext: SigningAttestationContext = {};
      let signer: (digest: Uint8Array) => Promise<Uint8Array>;
      // qscc signing gets its own slot and signer so read-only evaluations can
      // never overwrite or steal an in-flight decision attestation.
      const qsccContext: SigningAttestationContext = {};
      let qsccSigner: (digest: Uint8Array) => Promise<Uint8Array>;
      if (options.signerProvider) {
        signer = options.signerProvider(actor, certificate, attestationContext);
        qsccSigner = options.signerProvider(actor, certificate, qsccContext);
      } else {
        const keys = readdirSync(join(msp, 'keystore')).filter(name => name.endsWith('_sk'));
        if (keys.length !== 1) throw new Error('Expected one test enrollment signing key');
        const privateKey = createPrivateKey(readFileSync(join(msp, 'keystore', keys[0])));
        if (!parsed.checkPrivateKey(privateKey)) throw new Error('Test enrollment key does not match its certificate');
        signer = sdk.signers.newPrivateKeySigner(privateKey);
        qsccSigner = signer;
      }
      const identity = new ClientIdentity({ getCreator: () => ({ mspid: actor.org_id, idBytes: certificate }), getChannelID: () => 'kcl-demo', getTxID: () => 'identity-validation' });
      if (identity.getAttributeValue('kcl.actor_id') !== actor.actor_id || identity.getAttributeValue('kcl.actor_kind') !== actor.kind) throw new Error('Test certificate attributes do not match the signing route');
      const rpc = new grpc.Client(`127.0.0.1:${selected.peer_port}`, grpc.credentials.createSsl(readFileSync(join(base, 'peers', `peer0.${domain}`, 'tls/ca.crt'))), {
        'grpc.ssl_target_name_override': `peer0.${domain}`, 'grpc.default_authority': `peer0.${domain}`,
        ...fabricPeerChannelOptions,
      });
      let client: Awaited<ReturnType<typeof connectOfficialFabricGateway>> | undefined;
      let gateway: any;
      let outbox: SqliteOutbox | undefined;
      let qsccSigned: AttestationSerializer | undefined;
      try {
        client = await connectOfficialFabricGateway({ client: rpc, channel_id: 'kcl-demo', chaincode_name: 'kcl', credentials: { msp_id: actor.org_id, certificate, signer }, authorize: options.authorizeActor ? phase => options.authorizeActor!(actor, phase) : undefined, attestation: signingAttestationConfig(actor, attestationContext, options.signerProvider) });
        gateway = sdk.connect({ client: rpc, identity: { mspId: actor.org_id, credentials: certificate }, signer: qsccSigner, evaluateOptions: () => ({ deadline: Date.now() + 5000 }) });
        outbox = new SqliteOutbox(join(dataDir, `${actor.org_id}-${actor.actor_id}-outbox.sqlite`));
        // Claim the qscc serializer before publishing the route so a failed
        // claim cannot leave a route closed twice by nested catch handlers.
        if (options.signerProvider) qsccSigned = createAttestationSerializer(qsccContext);
        const opened = { client, gateway, outbox, qsccSigned };
        routes.push({ actor, transport: new FabricGatewayTransport({ client, outbox }), close() { closeAll([() => opened.outbox.close(), () => opened.client.close?.(), () => opened.gateway.close(), () => rpc.close(), () => { if (opened.qsccSigned !== undefined) releaseAttestationSerializer(qsccContext, opened.qsccSigned); }]); } });
        // Without a provider the qscc path runs unsigned like the write path.
        qsccGateways.push({ actor, gateway, signed: qsccSigned ?? ((_attestation, operation) => operation()) });
      } catch (error) { try { closeAll([() => outbox?.close(), () => client?.close?.(), () => gateway?.close(), () => rpc.close(), () => { if (qsccSigned !== undefined) releaseAttestationSerializer(qsccContext, qsccSigned); }]); } catch (cleanupError) { if (error instanceof Error && error.cause === undefined) error.cause = cleanupError; } throw error; }
    }
    projection = new SqliteFabricProjection(join(dataDir, 'fabric-projection.sqlite'), { channel_id: 'kcl-demo', chaincode_name: 'kcl', chaincode_version: '0.1.0', public_genesis: demoFixtures().config });
    // qscc reads are attested under the selected binding's actor — the
    // fixture's second identity when present, otherwise the first — so audit
    // consumers should read them as service reads by that signing identity,
    // not user-initiated actions.
    const qsccBinding = qsccGateways[1] ?? qsccGateways[0];
    if (qsccBinding === undefined) throw new Error('qscc signing binding is unavailable');
    const qscc = qsccBinding.gateway.getNetwork('kcl-demo').getContract('qscc');
    const ledger = new FabricApplicationLedger({ projection, routes, source: {
      async getTip() {
        // qscc signs through the actor's own slot; the serializer keeps the
        // read-only attestation bound to this evaluation alone.
        const bytes = await qsccBinding.signed(queryAttestation(qsccBinding.actor), () => qscc.evaluateTransaction('GetChainInfo', 'kcl-demo'));
        const info = common.BlockchainInfo.deserializeBinary(bytes);
        return { height: info.getHeight(), block_hash: Buffer.from(info.getCurrentblockhash_asU8()).toString('hex') };
      },
      getBlock: number => qsccBinding.signed(queryAttestation(qsccBinding.actor), () => qscc.evaluateTransaction('GetBlockByNumber', 'kcl-demo', String(number))),
    } });
    await ledger.recoverPending();
    return { ledger, personas: PERSONAS.filter(persona => persona.kind === 'human' && (!organization || persona.org_id === organization.org_id)), ...(organization ? { organization } : {}) };
  } catch (error) {
    for (const route of routes) {
      try { await route.close?.(); } catch (routeError) { if (error instanceof Error && error.cause === undefined) error.cause = routeError; }
    }
    try { projection?.close(); } catch (cleanupError) { if (error instanceof Error && error.cause === undefined) error.cause = cleanupError; }
    throw error;
  }
}
