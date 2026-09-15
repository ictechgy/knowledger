import { parseStrictJson } from "./canonical.ts";
import { idempotencyDigest } from "../domain/index.ts";
import type {
  AuthoritativeCommandResult,
  DurableOutbox,
  FabricGatewayClient,
  GatewayCommand,
  GatewayEndorsement,
  GatewayProposal,
  GatewayStatus,
  GatewaySubmitResult,
} from "./types.ts";

export interface OfficialGatewayCredentials {
  msp_id: string;
  certificate: Uint8Array;
  /** Gateway SDK signer callback; private key material stays with the caller. */
  signer: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;
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
  connect(options: { client: unknown; identity: { mspId: string; credentials: Uint8Array }; signer: OfficialGatewayCredentials["signer"]; hash?: unknown }): OfficialGateway;
}

export interface OfficialGatewayConnectionOptions {
  client: unknown;
  channel_id: string;
  chaincode_name: string;
  credentials: OfficialGatewayCredentials;
  module?: OfficialGatewayModule;
}

class OfficialGatewayClient implements FabricGatewayClient {
  private readonly commits = new Map<string, OfficialCommit>();
  private readonly gateway: OfficialGateway;
  private readonly contract: OfficialContract;
  private readonly mspId: string;
  constructor(contract: OfficialContract, gateway: OfficialGateway, mspId: string) { this.contract = contract; this.gateway = gateway; this.mspId = mspId; }

  async newProposal(command: GatewayCommand): Promise<GatewayProposal> {
    if (command.actor_org_id !== this.mspId) throw new Error('Command organization does not match the signing identity');
    const { actor_org_id: _actorOrg, ...wireCommand } = command;
    const proposal = this.contract.newProposal("Execute", { arguments: [JSON.stringify(wireCommand)] });
    return {
      tx_id: proposal.getTransactionId(),
      endorse: async () => {
        const endorsed = await proposal.endorse();
        let submitted: OfficialCommit | undefined;
        return {
          submit: async () => {
            const commit = await endorsed.submit();
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
    const status = await commit.getStatus();
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
    const bytes = await this.contract.evaluateTransaction("GetCommand", command.actor_org_id, command.command_id);
    if (!bytes || bytes.byteLength === 0) return undefined;
    const record = parseStrictJson(bytes) as Record<string, unknown>;
    if (!record || record.record_type !== 'IdempotencyRecord' || record.command_id !== command.command_id || typeof record.command_digest !== "string" || !("result" in record)) return undefined;
    return { payload_digest: record.command_digest, result: record.result };
  }

  close(): void { this.commits.clear(); this.gateway.close?.(); }
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
    const payloadDigest = idempotencyDigest({ command_id: command.command_id, type: command.type, input: command.input });
    let proposal: GatewayProposal;
    try {
      proposal = await this.newProposal(command);
    } catch {
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
    } catch {
      await this.config.outbox.updateAttempt(proposal.tx_id, { status: "unknown", detail: "endorsement_failed" });
      return pending(proposal.tx_id, payloadDigest);
    }
    try {
      await this.submit(endorsement);
      const commitBytes = await endorsement.getCommitBytes?.();
      await this.config.outbox.updateAttempt(proposal.tx_id, { status: "acknowledged", ...(commitBytes ? { commit_bytes: commitBytes } : {}) });
    } catch {
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
  const load = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<OfficialGatewayModule>;
  const module = options.module ?? await load("@hyperledger/fabric-gateway");
  const gateway = module.connect({
    client: options.client,
    identity: { mspId: options.credentials.msp_id, credentials: options.credentials.certificate },
    signer: options.credentials.signer,
    ...(module.hash?.sha256 ? { hash: module.hash.sha256 } : {}),
  });
  const network = gateway.getNetwork(options.channel_id);
  return new OfficialGatewayClient(network.getContract(options.chaincode_name), gateway, options.credentials.msp_id);
}
