import { jcsBytes, parseStrictJson, sha256Digest } from "./canonical.ts";
import type {
  Actor,
  Command,
  CoreEngine,
  FabricChaincodeConfig,
  FabricChaincodeResponse,
  FabricResponseFactory,
  FabricStub,
  IdentityDecoder,
  TxContext,
} from "./types.ts";

const DEFAULT_COMMAND_TYPES = ["publish_revision", "propose", "decide", "activate", "suspend", "withdraw", "fence"] as const;
const INTERNAL_BOOTSTRAP_KEY = "kcl:v1:bootstrap_manifest";

const defaultResponses: FabricResponseFactory = {
  success: (payload) => ({ status: 200, payload }),
  error: (message) => ({ status: 500, message }),
};

function safeMessage(code: string): string {
  return JSON.stringify({ code, message: code });
}

function timestamp(stub: FabricStub): string {
  const value = stub.getTxTimestamp?.();
  if (!value) return new Date(0).toISOString();
  const seconds = typeof value.seconds === "bigint" ? Number(value.seconds)
    : typeof value.seconds === "object" ? value.seconds.toNumber() : value.seconds;
  const millis = Math.floor(seconds * 1000 + (value.nanos ?? 0) / 1_000_000);
  return new Date(millis).toISOString();
}

function actorFromStub(stub: FabricStub, config: FabricChaincodeConfig): Actor {
  const decoder = config.identity_decoder;
  if (!decoder) throw new Error("authenticated Fabric ClientIdentity decoder is required");
  const identity = decoder(stub.getCreator(), stub);
  const allowed = config.allowed_org_ids ?? [...new Set(config.registered_identities.map((candidate) => candidate.msp_id))];
  if (!allowed.includes(identity.msp_id)) throw new Error("organization not allowed");
  if (!config.registered_identities.some((candidate) => candidate.msp_id === identity.msp_id && candidate.actor_id === identity.actor_id && candidate.actor_kind === identity.actor_kind)) {
    throw new Error("actor is not registered");
  }
  return { org_id: identity.msp_id, actor_id: identity.actor_id, kind: identity.actor_kind };
}

function parseCommand(bytes: Uint8Array): Command {
  const parsed = parseStrictJson(bytes);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("command must be an object");
  const command = parsed as Record<string, unknown>;
  if (Object.keys(command).some((key) => !["command_id", "type", "input"].includes(key))) throw new Error("command contains unsupported fields");
  if (typeof command.command_id !== "string" || typeof command.type !== "string" || !("input" in command)) {
    throw new Error("command fields missing");
  }
  return { command_id: command.command_id, type: command.type, input: command.input };
}

function assertPayloadIdentity(value: unknown, actor: Actor): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => assertPayloadIdentity(item, actor));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "actor_id" && item !== actor.actor_id) throw new Error("payload actor_id does not match certificate");
    if ((key === "actor_org_id" || key === "org_id") && item !== actor.org_id) throw new Error("payload org_id does not match certificate");
    if (key === "actor_kind" && item !== actor.kind) throw new Error("payload actor_kind does not match certificate");
    if (key === "actor" && item !== undefined) {
      if (!item || typeof item !== "object") throw new Error("payload actor is not permitted");
      const nested = item as Record<string, unknown>;
      assertPayloadIdentity(nested, actor);
    }
    assertPayloadIdentity(item, actor);
  }
}

function keyAllowed(key: string, allowed: readonly string[] | undefined, fallback: string): boolean {
  if (allowed) return allowed.some((prefix) => key === prefix || key.startsWith(prefix.endsWith(':') ? prefix : `${prefix}:`));
  return key.startsWith(fallback);
}

function idempotencyKey(orgId: string, commandId: string): string {
  return `kcl:v1:idempotency:${encodeURIComponent(orgId)}:${encodeURIComponent(commandId)}`;
}

function validCommandId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/u.test(value);
}

function parseStoredCommand(value: Uint8Array): { payload_digest: string; result: unknown } {
  const parsed = parseStrictJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("stored command malformed");
  const record = parsed as Record<string, unknown>;
  if (typeof record.payload_digest !== "string" || !("result" in record)) throw new Error("stored command malformed");
  return { payload_digest: record.payload_digest, result: record.result };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

class BufferedContext implements TxContext {
  readonly writes = new Map<string, Uint8Array>();
  readonly actor: Actor;
  readonly channel_id: string;
  readonly tx_id: string;
  readonly timestamp: string;
  readonly stub: FabricStub;
  private readonly config: FabricChaincodeConfig;
  constructor(actor: Actor, channel_id: string, tx_id: string, timestamp: string, stub: FabricStub, config: FabricChaincodeConfig) {
    this.actor = actor;
    this.channel_id = channel_id;
    this.tx_id = tx_id;
    this.timestamp = timestamp;
    this.stub = stub;
    this.config = config;
  }

  async get(key: string): Promise<unknown | undefined> {
    if (!keyAllowed(key, this.config.allowed_read_keys, "kcl:")) throw new Error("state key is not authorized");
    const buffered = this.writes.get(key);
    if (buffered) return parseStrictJson(buffered);
    const value = await this.stub.getState(key);
    if (!value || value.byteLength === 0) return undefined;
    return parseStrictJson(value);
  }

  async put(key: string, value: unknown): Promise<void> {
    if (!keyAllowed(key, this.config.allowed_write_prefixes, "kcl:")) throw new Error("state key is not authorized");
    this.writes.set(key, jcsBytes(value));
  }
}

export class FabricChaincode {
  private readonly responses: FabricResponseFactory;
  private readonly core: CoreEngine;
  private readonly config: FabricChaincodeConfig;
  constructor(core: CoreEngine, config: FabricChaincodeConfig) {
    this.core = core;
    this.config = config;
    this.responses = config.responses ?? defaultResponses;
    if (config.channel_id.length === 0 || !config.public_genesis || !config.bootstrap_identity) throw new Error("immutable Fabric config is required");
    if (!Array.isArray(config.registered_identities) || config.registered_identities.length === 0) throw new Error('Pinned registered identities are required');
    const registeredKeys = new Set<string>();
    const registeredOrgs = new Set<string>();
    for (const identity of config.registered_identities) {
      if (!identity.msp_id || !identity.actor_id || (identity.actor_kind !== "human" && identity.actor_kind !== "agent")) {
        throw new Error("pinned identity is malformed");
      }
      const key = `${identity.msp_id}|${identity.actor_id}|${identity.actor_kind}`;
      if (registeredKeys.has(key)) throw new Error("pinned identities contain duplicates");
      registeredKeys.add(key);
      registeredOrgs.add(identity.msp_id);
    }
    const bootstrap = config.bootstrap_identity;
    if (bootstrap.actor_kind !== "human" || !registeredKeys.has(`${bootstrap.msp_id}|${bootstrap.actor_id}|${bootstrap.actor_kind}`)) {
      throw new Error("bootstrap identity must be a pinned human identity");
    }
    if (config.allowed_org_ids) {
      const allowlist = new Set(config.allowed_org_ids);
      if (allowlist.size !== config.allowed_org_ids.length || allowlist.size === 0 || !allowlist.has(bootstrap.msp_id)) {
        throw new Error("organization allowlist is inconsistent with bootstrap identity");
      }
      for (const orgId of allowlist) {
        if (!registeredOrgs.has(orgId)) throw new Error("organization allowlist contains an unregistered organization");
      }
    }
  }

  async Init(stub: FabricStub): Promise<FabricChaincodeResponse> {
    try {
      if (stub.getChannelID() !== this.config.channel_id) throw new Error("channel mismatch");
      const actor = actorFromStub(stub, this.config);
      const pinned = this.config.bootstrap_identity;
      if (actor.org_id !== pinned.msp_id || actor.actor_id !== pinned.actor_id || actor.kind !== pinned.actor_kind) throw new Error("bootstrap identity is not pinned founder");
      let args = stub.getBufferArgs();
      if (args.length === 1 && decoder.decode(args[0]) === "Init") args = [];
      if (args.some((arg) => arg.byteLength > 0)) throw new Error("bootstrap input is not accepted");
      const existing = await stub.getState(INTERNAL_BOOTSTRAP_KEY);
      const digest = sha256Digest(this.config.public_genesis);
      if (existing.byteLength > 0) {
        const marker = parseStoredCommand(existing);
        if (marker.payload_digest !== digest) throw new Error("bootstrap manifest conflicts");
        return this.responses.success(encoder.encode(JSON.stringify({ status: "already_bootstrapped" })));
      }
      const ctx = new BufferedContext(actor, this.config.channel_id, stub.getTxID(), timestamp(stub), stub, this.config);
      const result = await this.core.bootstrap(ctx, this.config.public_genesis);
      ctx.writes.set(INTERNAL_BOOTSTRAP_KEY, jcsBytes({ payload_digest: digest, result }));
      await this.flush(ctx);
      return this.responses.success(encoder.encode(JSON.stringify({ status: "bootstrapped", result })));
    } catch {
      return this.responses.error(safeMessage("BOOTSTRAP_REJECTED"));
    }
  }

  async Invoke(stub: FabricStub): Promise<FabricChaincodeResponse> {
    try {
      if (stub.getChannelID() !== this.config.channel_id) throw new Error("channel mismatch");
      const actor = actorFromStub(stub, this.config);
      let args = stub.getBufferArgs();
      if (args.length === 2 && decoder.decode(args[0]) === "Execute") args = [args[1]];
      if (args.length === 3 && decoder.decode(args[0]) === "GetCommand") {
        const requestedOrg = decoder.decode(args[1]);
        const requestedCommand = decoder.decode(args[2]);
        if (requestedOrg !== actor.org_id || !validCommandId(requestedCommand)) throw new Error("command lookup is not authorized");
        const key = idempotencyKey(requestedOrg, requestedCommand);
        if (!keyAllowed(key, this.config.allowed_read_keys, "kcl:")) throw new Error("state key is not authorized");
        const value = await stub.getState(key);
        if (value.byteLength > 0) {
          const record = parseStrictJson(value);
          if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("stored command malformed");
          const storedActor = (record as Record<string, unknown>).actor;
          if (!storedActor || typeof storedActor !== "object" || Array.isArray(storedActor)) throw new Error("stored command actor missing");
          const actorRecord = storedActor as Record<string, unknown>;
          if (actorRecord.org_id !== actor.org_id || actorRecord.actor_id !== actor.actor_id || actorRecord.kind !== actor.kind) throw new Error("stored command actor mismatch");
        }
        return this.responses.success(value);
      }
      if (args.length !== 1) throw new Error("exactly one JSON command is required");
      const command = parseCommand(args[0]);
      const allowedTypes = this.config.allowed_command_types ?? DEFAULT_COMMAND_TYPES;
      if (!allowedTypes.includes(command.type)) throw new Error("command type is not allowed");
      assertPayloadIdentity(command.input, actor);
      const ctx = new BufferedContext(actor, this.config.channel_id, stub.getTxID(), timestamp(stub), stub, this.config);
      const result = await this.core.execute(ctx, command);
      await this.flush(ctx);
      return this.responses.success(encoder.encode(JSON.stringify({ status: "executed", result })));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && error.code === 'IDEMPOTENCY_CONFLICT' ? 'IDEMPOTENCY_CONFLICT' : 'COMMAND_REJECTED';
      return this.responses.error(safeMessage(code));
    }
  }

  private async flush(ctx: BufferedContext): Promise<void> {
    for (const [key, value] of ctx.writes) await ctx.stub.putState(key, value);
  }
}
