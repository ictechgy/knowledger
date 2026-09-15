export type ActorKind = "human" | "agent";

export interface Actor {
  org_id: string;
  actor_id: string;
  kind: ActorKind;
}

export interface Command {
  command_id: string;
  type: string;
  input: unknown;
}

export interface TxContext {
  actor: Actor;
  channel_id: string;
  tx_id: string;
  timestamp: string;
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface CoreEngine {
  execute(ctx: TxContext, command: Command): Promise<unknown>;
  bootstrap(ctx: TxContext, config: unknown): Promise<unknown>;
}

export interface FabricCreator {
  msp_id?: string;
  mspid?: string;
  id_bytes?: Uint8Array;
  idBytes?: Uint8Array;
  [key: string]: unknown;
}

export interface AuthenticatedFabricIdentity {
  msp_id: string;
  actor_id: string;
  actor_kind: ActorKind;
}

export type IdentityDecoder = (creator: unknown, stub: FabricStub) => AuthenticatedFabricIdentity;

export interface FabricStub {
  getCreator(): unknown;
  getTxID(): string;
  getChannelID(): string;
  getTxTimestamp?(): { seconds: number | bigint | { toNumber(): number }; nanos?: number };
  /** fabric-shim 2.5.x exposes display arguments as strings and raw bytes separately. */
  getArgs(): string[];
  getBufferArgs(): Uint8Array[];
  getState(key: string): Promise<Uint8Array>;
  putState(key: string, value: Uint8Array): Promise<void>;
}

export interface FabricResponseFactory {
  success(payload: Uint8Array): FabricChaincodeResponse;
  error(message: string): FabricChaincodeResponse;
}

export interface FabricChaincodeResponse {
  status: number;
  message?: string;
  payload?: Uint8Array;
}

export interface BootstrapIdentity {
  msp_id: string;
  actor_id: string;
  actor_kind: ActorKind;
}

export interface FabricChaincodeConfig {
  channel_id: string;
  public_genesis: unknown;
  bootstrap_identity: BootstrapIdentity;
  allowed_org_ids?: readonly string[];
  allowed_command_types?: readonly string[];
  allowed_read_keys?: readonly string[];
  allowed_write_prefixes?: readonly string[];
  registered_identities: readonly AuthenticatedFabricIdentity[];
  identity_decoder?: IdentityDecoder;
  responses?: FabricResponseFactory;
}

export interface GatewayCommand extends Command {
  actor_org_id: string;
}

export interface GatewayProposal {
  tx_id: string;
  endorse(): Promise<GatewayEndorsement>;
}

export interface GatewayEndorsement {
  submit(): Promise<unknown>;
  getResult?(): Promise<unknown>;
  getCommitBytes?(): Promise<Uint8Array>;
}

export type CommitStatus = "VALID" | "INVALID" | "UNKNOWN" | "PENDING" | "ACK";

export interface GatewayStatus {
  status: CommitStatus;
  block_number?: number | string;
  transaction_index?: number | string;
  code?: string;
}

export interface AuthoritativeCommandResult {
  payload_digest: string;
  result: unknown;
}

export interface FabricGatewayClient {
  newProposal(command: GatewayCommand): Promise<GatewayProposal>;
  getStatus(tx_id: string, commit_bytes?: Uint8Array): Promise<GatewayStatus>;
  getAuthoritativeCommandResult?(command: Pick<GatewayCommand, "command_id" | "actor_org_id">): Promise<AuthoritativeCommandResult | undefined>;
  close?(): void;
}

export type OutboxAttemptStatus =
  | "pending"
  | "endorsed"
  | "acknowledged"
  | "valid"
  | "invalid"
  | "reconciled"
  | "unknown";

export interface OutboxAttempt {
  command_id: string;
  actor_org_id: string;
  payload_digest: string;
  tx_id: string;
  status: OutboxAttemptStatus;
  detail?: string;
  commit_bytes?: Uint8Array;
}

export interface DurableOutbox {
  recordAttempt(attempt: OutboxAttempt): Promise<void>;
  updateAttempt(tx_id: string, update: Pick<OutboxAttempt, "status"> & Partial<Pick<OutboxAttempt, "detail" | "commit_bytes">>): Promise<void>;
  listRecoverable?(): Promise<OutboxAttempt[]>;
}

export interface GatewaySubmitResult {
  status: "valid" | "invalid" | "pending";
  tx_id: string;
  payload_digest: string;
  result?: unknown;
  code?: string;
}
