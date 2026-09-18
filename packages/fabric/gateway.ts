import { parseStrictJson } from "./canonical.ts";
import { idempotencyDigest } from "../domain/index.ts";
import { assertSigningAttestation, createAttestationSerializer, releaseAttestationSerializer } from "./remote-signer.ts";
import type { Attestation, QueryAttestation, SigningAttestation, SigningAttestationContext } from "./remote-signer.ts";
import type {
  Actor,
  AuthoritativeCommandResult,
  DurableOutbox,
  FabricGatewayClient,
  GatewayCommand,
  GatewayEndorsement,
  GatewayProposal,
  GatewayStatus,
  GatewaySubmitResult,
  OutboxAttempt,
} from "./types.ts";

export interface OfficialGatewayCredentials {
  msp_id: string;
  certificate: Uint8Array;
  /** Gateway SDK signer callback; private key material stays with the caller. */
  signer: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export type FabricWritePhase = 'proposal' | 'endorse' | 'submit';
export type SigningPhase = 'proposal' | 'submit';

export interface GatewayAttestation {
  /** Slot shared with the remote signer; refreshed before each signing call. */
  context: SigningAttestationContext;
  /** Decision attestation for the exact write; a missing or mismatched result fails the call before any signature. */
  build(command: Pick<GatewayCommand, "command_id" | "type" | "input">, phase: SigningPhase, txId: string): SigningAttestation;
  /** Attestation for read-only signing (evaluate/status); no command binding. */
  buildQuery(): QueryAttestation;
}

/** Organisation attestation binding the actor to the exact command decision and transaction. */
export function decisionAttestation(actor: Actor, command: Pick<GatewayCommand, "command_id" | "type" | "input">, phase: SigningPhase, txId: string): SigningAttestation {
  return {
    org_id: actor.org_id,
    actor_id: actor.actor_id,
    actor_kind: actor.kind,
    command_id: command.command_id,
    command_type: command.type,
    command_digest: idempotencyDigest({ type: command.type, input: command.input }),
    phase,
    tx_id: txId,
  };
}

/** Organisation attestation for a read-only signing operation (evaluate/status). */
export function queryAttestation(actor: Actor): QueryAttestation {
  return { org_id: actor.org_id, actor_id: actor.actor_id, actor_kind: actor.kind, phase: "query" };
}

/** Authorization failed before the SDK could send this write phase. */
export class FabricAuthorizationCancelled extends Error {
  constructor(cause: unknown) { super('Authorization cancelled before Fabric submission', { cause }); this.name = 'FabricAuthorizationCancelled'; }
}

interface OfficialCommit {
  getBytes(): Uint8Array;
  getTransactionId(): string;
  getStatus(): Promise<{ code: number | string; blockNumber?: number | bigint | string; transactionIndex?: number | bigint | string }>;
}

interface OfficialEndorsedProposal {
  submit(): Promise<OfficialCommit>;
  getResult(): Uint8Array;
}

interface OfficialProposal {
  getTransactionId(): string;
  endorse(): Promise<OfficialEndorsedProposal>;
}

interface OfficialContract {
  newProposal(transactionName: string, options: { arguments: string[] }): OfficialProposal;
  evaluateTransaction(transactionName: string, ...args: string[]): Promise<Uint8Array>;
}

interface OfficialGateway {
  newCommit(bytes: Uint8Array): OfficialCommit;
  close?(): void;
  getNetwork(channel_id: string): { getContract(chaincode_name: string): OfficialContract };
}

interface OfficialGatewayModule {
  hash?: { sha256: unknown };
  connect(options: {
    client: unknown; identity: { mspId: string; credentials: Uint8Array };
    signer: OfficialGatewayCredentials["signer"]; hash?: unknown;
    evaluateOptions: () => { deadline: number }; endorseOptions: () => { deadline: number };
    submitOptions: () => { deadline: number }; commitStatusOptions: () => { deadline: number };
  }): OfficialGateway;
}

/**
 * peer 연결용 gRPC 채널 keepalive. 포워딩된 연결이 중간 경로에서 조용히 끊겨도
 * 응답 없는 ping으로 감지해 채널을 재연결한다. 간격은 Fabric 서버의
 * enforcementMinTime(기본 5s)보다 충분히 길게 둔다.
 */
export const fabricPeerChannelOptions = Object.freeze({
  "grpc.keepalive_time_ms": 20_000,
  "grpc.keepalive_timeout_ms": 5_000,
  "grpc.keepalive_permit_without_calls": 1,
  "grpc.http2.max_pings_without_data": 0,
});

export interface OfficialGatewayConnectionOptions {
  client: unknown;
  channel_id: string;
  chaincode_name: string;
  credentials: OfficialGatewayCredentials;
  /** Per-call deadlines; unknown commit status remains recoverable in the outbox. */
  timeouts_ms?: Partial<Record<'evaluate' | 'endorse' | 'submit' | 'commit_status', number>>;
  module?: OfficialGatewayModule;
  /**
   * Recheck the active authenticated request before each write phase. The
   * callback runs inside the signing serialiser, so it must not re-enter
   * signer-bearing calls on this client — doing so queues behind itself and
   * deadlocks.
   */
  authorize?: (phase: FabricWritePhase) => Promise<void>;
  /** Organisation decision attestation shared with the signing gateway. */
  attestation?: GatewayAttestation;
}

class OfficialGatewayClient implements FabricGatewayClient {
  private readonly commits = new Map<string, OfficialCommit>();
  private readonly gateway: OfficialGateway;
  private readonly contract: OfficialContract;
  private readonly mspId: string;
  private readonly authorize?: (phase: FabricWritePhase) => Promise<void>;
  private readonly attestation?: GatewayAttestation;
  /** Serialises every signer-bearing SDK call so attestations cannot interleave. */
  private readonly signed: <T>(attestation: Attestation | undefined, operation: () => Promise<T>) => Promise<T>;
  constructor(contract: OfficialContract, gateway: OfficialGateway, mspId: string, authorize?: (phase: FabricWritePhase) => Promise<void>, attestation?: GatewayAttestation) {
    this.contract = contract; this.gateway = gateway; this.mspId = mspId; this.authorize = authorize; this.attestation = attestation;
    this.signed = attestation === undefined ? (_attestation, operation) => operation() : createAttestationSerializer(attestation.context);
  }

  private async assertAuthorized(phase: FabricWritePhase): Promise<void> {
    try { await this.authorize?.(phase); }
    catch (error) { throw new FabricAuthorizationCancelled(error); }
  }

  // The attestation builder is caller-supplied runtime code: its output must
  // be checked against the operation being signed before it is installed,
  // otherwise a faulty builder could attach arbitrary claims — or a
  // query-shaped attestation — to a write, which the signing service would
  // countersign because it validates identity and shape only.
  private buildDecision(command: Pick<GatewayCommand, "command_id" | "type" | "input">, phase: SigningPhase, txId: string): SigningAttestation | undefined {
    if (this.attestation === undefined) return undefined;
    // Capture the expected claims before invoking the builder: it receives the
    // same snapshot object and could mutate it, so the comparison values must
    // be fixed before the call, not read back afterwards.
    const expectedId = command.command_id;
    const expectedType = command.type;
    const expectedDigest = idempotencyDigest({ type: command.type, input: command.input });
    const built = this.attestation.build(command, phase, txId);
    // A configured builder that declines to produce evidence must not let the
    // write proceed unattested — that is a wiring bug, not a policy choice.
    if (built === undefined) throw new Error("Attestation builder produced no evidence for a signed write");
    const checked = assertSigningAttestation(built);
    if (checked.phase === "query" || checked.command_id !== expectedId || checked.command_type !== expectedType || checked.command_digest !== expectedDigest || checked.phase !== phase || checked.tx_id !== txId) {
      throw new Error("Attestation builder returned claims that do not match the signed operation");
    }
    return checked;
  }

  private buildQueryAttestation(): QueryAttestation | undefined {
    if (this.attestation === undefined) return undefined;
    const built = this.attestation.buildQuery();
    if (built === undefined) throw new Error("Attestation builder produced no evidence for a signed read");
    const checked = assertSigningAttestation(built);
    if (checked.phase !== "query") throw new Error("Attestation builder returned a decision attestation for a read-only operation");
    return checked;
  }

  async newProposal(command: GatewayCommand): Promise<GatewayProposal> {
    if (command.actor_org_id !== this.mspId) throw new Error('Command organization does not match the signing identity');
    await this.assertAuthorized('proposal');
    const { actor_org_id: _actorOrg, ...wireCommand } = command;
    const wireJson = JSON.stringify(wireCommand);
    const proposal = this.contract.newProposal("Execute", { arguments: [wireJson] });
    // Snapshot the attested command at proposal time: a caller mutating the
    // original object afterwards must not detach the receipt's command digest
    // from the proposal bytes the peer actually signs.
    const attestedCommand = JSON.parse(wireJson) as Pick<GatewayCommand, "command_id" | "type" | "input">;
    return {
      tx_id: proposal.getTransactionId(),
      endorse: async () => {
        // The SDK signs the proposal inside endorse(); the attestation install
        // and the signing call are serialised so nothing else on this
        // connection can consume or replace the decision context. Note the two
        // vocabularies at this point: the authorisation phase is 'endorse'
        // while the attestation records the signed artefact ('proposal'), so
        // audit reconciliation should expect that pairing rather than equal
        // phase names. Authorisation runs inside the serialised section so it
        // is evaluated at signing time, not before the queue wait.
        const endorsed = await this.signed(this.buildDecision(attestedCommand, 'proposal', proposal.getTransactionId()), async () => { await this.assertAuthorized('endorse'); return proposal.endorse(); });
        let submitted: OfficialCommit | undefined;
        return {
          submit: async () => {
            const commit = await this.signed(this.buildDecision(attestedCommand, 'submit', proposal.getTransactionId()), async () => { await this.assertAuthorized('submit'); return endorsed.submit(); });
            submitted = commit;
            this.commits.set(proposal.getTransactionId(), commit);
            return commit;
          },
          getResult: async () => {
            const wire = parseStrictJson(endorsed.getResult()) as any;
            if (!wire || wire.status !== 'executed' || !Object.hasOwn(wire, 'result')) throw new Error('Malformed committed chaincode response');
            return wire.result;
          },
          getCommitBytes: async () => {
            if (!submitted) throw new Error('No acknowledged commit handle');
            return submitted.getBytes();
          },
        };
      },
    };
  }

  async getStatus(tx_id: string, commit_bytes?: Uint8Array): Promise<GatewayStatus> {
    let commit = this.commits.get(tx_id);
    if (!commit && commit_bytes) {
      commit = this.gateway.newCommit(commit_bytes);
      if (commit.getTransactionId() !== tx_id) throw new Error('Persisted commit does not match its transaction');
    }
    if (!commit) return { status: "UNKNOWN" };
    const status = await this.signed(this.buildQueryAttestation(), () => commit.getStatus());
    const valid = status.code === 0 || status.code === "VALID";
    this.commits.delete(tx_id);
    return {
      status: valid ? "VALID" : "INVALID",
      code: String(status.code),
      block_number: normalizeLedgerNumber(status.blockNumber),
      transaction_index: normalizeLedgerNumber(status.transactionIndex),
    };
  }

  async getAuthoritativeCommandResult(command: Pick<GatewayCommand, "command_id" | "actor_org_id">): Promise<AuthoritativeCommandResult | undefined> {
    if (command.actor_org_id !== this.mspId) throw new Error('Recovery organization does not match the signing identity');
    const bytes = await this.signed(this.buildQueryAttestation(), () => this.contract.evaluateTransaction("GetCommand", command.actor_org_id, command.command_id));
    if (!bytes || bytes.byteLength === 0) return undefined;
    const record = parseStrictJson(bytes) as Record<string, unknown>;
    if (!record || record.record_type !== 'IdempotencyRecord' || record.command_id !== command.command_id || typeof record.command_digest !== "string" || !("result" in record)) return undefined;
    return { payload_digest: record.command_digest, result: record.result };
  }

  close(): void {
    this.commits.clear();
    if (this.attestation) {
      // Release this serializer's ownership claim so a reconnect may reuse the
      // same caller-provided context object; the release is tagged so a
      // repeated close cannot evict a replacement serializer's claim.
      releaseAttestationSerializer(this.attestation.context, this.signed);
    }
    this.gateway.close?.();
  }
}

function normalizeLedgerNumber(value: number | bigint | string | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : String(value);
  return value;
}

export interface FabricGatewayTransportConfig {
  client: FabricGatewayClient;
  outbox: DurableOutbox;
}

function pending(tx_id: string, digest: string): GatewaySubmitResult {
  return { status: "pending", tx_id, payload_digest: digest };
}

export class FabricGatewayTransport {
  private readonly config: FabricGatewayTransportConfig;
  constructor(config: FabricGatewayTransportConfig) { this.config = config; }

  async newProposal(command: GatewayCommand): Promise<GatewayProposal> {
    return this.config.client.newProposal(command);
  }

  async endorse(proposal: GatewayProposal): Promise<GatewayEndorsement> {
    return proposal.endorse();
  }

  async submit(endorsement: GatewayEndorsement): Promise<unknown> {
    return endorsement.submit();
  }

  async getStatus(tx_id: string, commit_bytes?: Uint8Array): Promise<GatewayStatus> {
    return this.config.client.getStatus(tx_id, commit_bytes);
  }

  async execute(command: GatewayCommand): Promise<GatewaySubmitResult> {
    const payloadDigest = idempotencyDigest({ type: command.type, input: command.input });
    let proposal: GatewayProposal;
    try {
      proposal = await this.newProposal(command);
    } catch (error) {
      if (error instanceof FabricAuthorizationCancelled) throw error.cause;
      return { status: "pending", tx_id: "", payload_digest: payloadDigest };
    }
    const attempt = {
      command_id: command.command_id,
      actor_org_id: command.actor_org_id,
      payload_digest: payloadDigest,
      tx_id: proposal.tx_id,
      status: "pending" as const,
    };
    // This durable write intentionally precedes submit(). Every tx ID is recoverable after a timeout.
    await this.config.outbox.recordAttempt(attempt);
    let endorsement: GatewayEndorsement;
    try {
      endorsement = await this.endorse(proposal);
      await this.config.outbox.updateAttempt(proposal.tx_id, { status: "endorsed" });
    } catch (error) {
      if (error instanceof FabricAuthorizationCancelled) {
        await this.config.outbox.updateAttempt(proposal.tx_id, { status: 'cancelled', detail: 'authorization_cancelled' });
        throw error.cause;
      }
      await this.config.outbox.updateAttempt(proposal.tx_id, { status: "unknown", detail: "endorsement_failed" });
      return pending(proposal.tx_id, payloadDigest);
    }
    try {
      await this.submit(endorsement);
      const commitBytes = await endorsement.getCommitBytes?.();
      await this.config.outbox.updateAttempt(proposal.tx_id, { status: "acknowledged", ...(commitBytes ? { commit_bytes: commitBytes } : {}) });
    } catch (error) {
      if (error instanceof FabricAuthorizationCancelled) {
        await this.config.outbox.updateAttempt(proposal.tx_id, { status: 'cancelled', detail: 'authorization_cancelled' });
        throw error.cause;
      }
      // A submit timeout is deliberately resolved through the peer status query below.
      await this.config.outbox.updateAttempt(proposal.tx_id, { status: "unknown", detail: "submit_status_unknown" });
    }
    let status: GatewayStatus;
    try {
      status = await this.getStatus(proposal.tx_id);
    } catch {
      status = { status: 'UNKNOWN' };
    }
    if (status.status === "VALID") {
      await this.config.outbox.updateAttempt(proposal.tx_id, { status: "valid" });
      const result = await endorsement.getResult?.();
      return { status: "valid", tx_id: proposal.tx_id, payload_digest: payloadDigest, ...(result === undefined ? {} : { result }) };
    }
    const authoritative = await this.reconcileInvalid(command, payloadDigest);
    if (authoritative.state === "unavailable") return pending(proposal.tx_id, payloadDigest);
    if (authoritative.state === "matched" && authoritative.result) {
      await this.config.outbox.updateAttempt(proposal.tx_id, { status: "reconciled", detail: "authoritative_idempotency_result" });
      return { status: "valid", tx_id: proposal.tx_id, payload_digest: payloadDigest, result: authoritative.result.result };
    }
    if (status.status !== "INVALID") return pending(proposal.tx_id, payloadDigest);
    await this.config.outbox.updateAttempt(proposal.tx_id, { status: "invalid", detail: status.code ?? "INVALID" });
    return { status: "invalid", tx_id: proposal.tx_id, payload_digest: payloadDigest, code: status.code };
  }

  async recover(attempt: { command_id: string; actor_org_id: string; payload_digest: string; tx_id: string; commit_bytes?: Uint8Array }): Promise<GatewaySubmitResult> {
    let status: GatewayStatus;
    try {
      status = await this.getStatus(attempt.tx_id, attempt.commit_bytes);
    } catch {
      status = { status: 'UNKNOWN' };
    }
    if (status.status === "VALID") {
      await this.config.outbox.updateAttempt(attempt.tx_id, { status: "valid" });
      return { status: "valid", tx_id: attempt.tx_id, payload_digest: attempt.payload_digest };
    }
    const command = { command_id: attempt.command_id, actor_org_id: attempt.actor_org_id, type: "", input: {} };
    const authoritative = await this.reconcileInvalid(command, attempt.payload_digest);
    if (authoritative.state === "unavailable") return pending(attempt.tx_id, attempt.payload_digest);
    if (authoritative.state === "matched" && authoritative.result) {
      await this.config.outbox.updateAttempt(attempt.tx_id, { status: "reconciled", detail: "authoritative_idempotency_result" });
      return { status: "valid", tx_id: attempt.tx_id, payload_digest: attempt.payload_digest, result: authoritative.result.result };
    }
    if (status.status !== "INVALID") return pending(attempt.tx_id, attempt.payload_digest);
    await this.config.outbox.updateAttempt(attempt.tx_id, { status: "invalid", detail: status.code ?? "INVALID" });
    return { status: "invalid", tx_id: attempt.tx_id, payload_digest: attempt.payload_digest, code: status.code };
  }

  async recoverPending(): Promise<GatewaySubmitResult[]> {
    const attempts = await this.config.outbox.listRecoverable?.() ?? [];
    const results: GatewaySubmitResult[] = [];
    for (const attempt of attempts) results.push(await this.recover(attempt));
    return results;
  }

  /** 재시작 복구 대상이 되는 미확정 시도 목록. 운영 관측용이며 재제출하지 않는다. */
  async recoverableAttempts(): Promise<OutboxAttempt[]> {
    return this.config.outbox.listRecoverable?.() ?? [];
  }

  /** Observe at most one outstanding attempt; never create, endorse or submit a proposal. */
  async observeCommand(command: GatewayCommand, queryPeer: boolean): Promise<{status:'pending'|'rejected'|'cancelled';code?:string}|undefined> {
    const load = () => this.config.outbox.listCommandAttempts?.(command.actor_org_id,command.command_id);
    let attempts = await load();
    if (!attempts?.length) return undefined;
    const digest = idempotencyDigest(command);
    const validate = () => {
      if (attempts!.some(attempt=>attempt.command_id!==command.command_id || attempt.actor_org_id!==command.actor_org_id || attempt.payload_digest!==digest
        || !['pending','endorsed','acknowledged','unknown','valid','invalid','reconciled','cancelled'].includes(attempt.status))) throw new Error('Outbox command binding is invalid');
    };
    validate();
    if (attempts.length>128) return {status:'pending'};
    const pendingAttempt=attempts.find(attempt=>['pending','endorsed','acknowledged','unknown'].includes(attempt.status));
    if (queryPeer && pendingAttempt) { await this.recover(pendingAttempt); attempts=await load(); validate(); }
    // SDK VALID/reconciliation is still waiting for the application projection.
    if (attempts!.some(attempt=>!['invalid','cancelled'].includes(attempt.status))) return {status:'pending'};
    return attempts!.every(attempt=>attempt.status==='cancelled') ? {status:'cancelled',code:'AUTHORIZATION_CANCELLED'} : {status:'rejected',code:'LEDGER_CONFLICT'};
  }

  private async reconcileInvalid(command: GatewayCommand, digest: string): Promise<{ state: "unavailable" | "absent" | "matched"; result?: AuthoritativeCommandResult }> {
    if (!this.config.client.getAuthoritativeCommandResult) return { state: "absent" };
    let result: AuthoritativeCommandResult | undefined;
    try {
      result = await this.config.client.getAuthoritativeCommandResult(command);
    } catch {
      return { state: "unavailable" };
    }
    if (!result || result.payload_digest !== digest) return { state: "absent" };
    return { state: "matched", result };
  }
}

export async function connectOfficialFabricGateway(options: OfficialGatewayConnectionOptions): Promise<FabricGatewayClient> {
  if (!options.credentials || options.credentials.certificate.byteLength === 0 || typeof options.credentials.signer !== "function") {
    throw new Error("caller-provided gateway identity and signer are required");
  }
  const timeouts = { evaluate: 5000, endorse: 15000, submit: 15000, commit_status: 30000, ...options.timeouts_ms };
  for (const value of Object.values(timeouts)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Gateway timeouts must be positive integer milliseconds');
  }
  const load = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<OfficialGatewayModule>;
  const module = options.module ?? await load("@hyperledger/fabric-gateway");
  const gateway = module.connect({
    client: options.client,
    identity: { mspId: options.credentials.msp_id, credentials: options.credentials.certificate },
    signer: options.credentials.signer,
    evaluateOptions: () => ({ deadline: Date.now() + timeouts.evaluate }),
    endorseOptions: () => ({ deadline: Date.now() + timeouts.endorse }),
    submitOptions: () => ({ deadline: Date.now() + timeouts.submit }),
    commitStatusOptions: () => ({ deadline: Date.now() + timeouts.commit_status }),
    ...(module.hash?.sha256 ? { hash: module.hash.sha256 } : {}),
  });
  const network = gateway.getNetwork(options.channel_id);
  try {
    // createAttestationSerializer may reject an already-claimed context; the
    // connected gateway must not leak when client construction fails.
    return new OfficialGatewayClient(network.getContract(options.chaincode_name), gateway, options.credentials.msp_id, options.authorize, options.attestation);
  } catch (error) {
    gateway.close?.();
    throw error;
  }
}
