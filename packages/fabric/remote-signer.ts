import { connect as connectSocket } from "node:net";
import { isAbsolute } from "node:path";
import { createHash, verify, X509Certificate } from "node:crypto";
import { jcsBytes, parseStrictJson } from "./canonical.ts";

const MAX_FRAME_BYTES = 32 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_SOCKET_PATH_BYTES = 104;

export type SigningKeyId = string;

/** Decision context the organisation gateway attests before using its key. */
export interface SigningAttestation {
  org_id: string;
  actor_id: string;
  actor_kind: "human" | "agent";
  command_id: string;
  command_type: string;
  command_digest: string;
  phase: "proposal" | "submit";
  /** Fabric transaction ID the SDK already assigned at proposal time; auditors reconcile it against the ledger. */
  tx_id: string;
}

/** Organisational attestation for read-only signing (evaluate/status); carries no command binding. */
export interface QueryAttestation {
  org_id: string;
  actor_id: string;
  actor_kind: "human" | "agent";
  phase: "query";
}

export type Attestation = SigningAttestation | QueryAttestation;

/** Mutable per-connection slot the gateway client fills before each signing call. */
export interface SigningAttestationContext {
  current?: Attestation;
}

const MAX_ATTESTATION_FIELD_CHARS = 128;
const COMMAND_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function attestationField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ATTESTATION_FIELD_CHARS) {
    throw new TypeError(`Signing attestation ${name} is outside the supported bounds`);
  }
  return value;
}

export function assertSigningAttestation(value: unknown): Attestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Signing attestation must be an object");
  const attestation = value as Partial<SigningAttestation>;
  const keys = Object.keys(value);
  if ((attestation as { phase?: unknown }).phase === "query") {
    const required = ["org_id", "actor_id", "actor_kind", "phase"];
    if (!required.every(key => keys.includes(key)) || keys.length !== required.length) {
      throw new TypeError("Signing attestation has missing or unknown fields");
    }
    const orgId = attestationField(attestation.org_id, "org_id");
    const actorId = attestationField(attestation.actor_id, "actor_id");
    if (attestation.actor_kind !== "human" && attestation.actor_kind !== "agent") throw new TypeError("Signing attestation actor_kind is outside the supported bounds");
    return { org_id: orgId, actor_id: actorId, actor_kind: attestation.actor_kind, phase: "query" };
  }
  const required = ["org_id", "actor_id", "actor_kind", "command_id", "command_type", "command_digest", "phase", "tx_id"];
  if (!required.every(key => keys.includes(key)) || !keys.every(key => required.includes(key))) {
    throw new TypeError("Signing attestation has missing or unknown fields");
  }
  const orgId = attestationField(attestation.org_id, "org_id");
  const actorId = attestationField(attestation.actor_id, "actor_id");
  const commandId = attestationField(attestation.command_id, "command_id");
  const commandType = attestationField(attestation.command_type, "command_type");
  const txId = attestationField(attestation.tx_id, "tx_id");
  if (attestation.actor_kind !== "human" && attestation.actor_kind !== "agent") throw new TypeError("Signing attestation actor_kind is outside the supported bounds");
  if (typeof attestation.command_digest !== "string" || !COMMAND_DIGEST_PATTERN.test(attestation.command_digest)) throw new TypeError("Signing attestation command_digest is outside the supported bounds");
  if (attestation.phase !== "proposal" && attestation.phase !== "submit") throw new TypeError("Signing attestation phase is outside the supported bounds");
  return {
    org_id: orgId, actor_id: actorId, actor_kind: attestation.actor_kind,
    command_id: commandId, command_type: commandType, command_digest: attestation.command_digest, phase: attestation.phase,
    tx_id: txId,
  };
}

export type RemoteSignerErrorCode =
  | "invalid_request"
  | "unknown_key"
  | "rejected"
  | "protocol_error"
  | "service_unavailable"
  | "timeout";

export class RemoteSignerError extends Error {
  readonly code: RemoteSignerErrorCode;

  constructor(code: RemoteSignerErrorCode, message = "Remote signing request failed") {
    super(message);
    this.name = "RemoteSignerError";
    this.code = code;
  }
}

export interface RemoteSignerOptions {
  socketPath: string;
  keyId: SigningKeyId;
  certificate: Uint8Array;
  timeoutMs?: number;
  /** Per-request decision context; called before every signing frame is sent. */
  attestation?: () => Attestation | undefined;
  /** Called with each verified attestation receipt and its canonical evidence so callers can keep the proof. Must be synchronous — a promise return fails the request. */
  onAttestationReceipt?: (receipt: Uint8Array, evidence: Uint8Array) => void;
}

interface SignRequest {
  operation: "sign";
  key_id: SigningKeyId;
  digest: string;
  certificate: string;
  attestation?: Attestation;
}

interface ErrorResponse {
  ok: false;
  error: RemoteSignerErrorCode;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;

function assertKeyId(keyId: string): void {
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) throw new RangeError("Signing key ID is outside the supported format");
}

function assertSocketPath(socketPath: string): void {
  if (typeof socketPath !== "string" || socketPath.length === 0 || !isAbsolute(socketPath)) {
    throw new TypeError("A Unix socket path is required");
  }
  if (socketPath.includes("\u0000") || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new RangeError("Unix socket path is too long");
  }
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError("Signing timeout is outside the supported range");
  }
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength === 0 || body.byteLength > MAX_FRAME_BYTES) throw new RemoteSignerError("invalid_request");
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeBase64Url(value: unknown, expectedBytes?: number, maximumBytes = MAX_FRAME_BYTES): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RemoteSignerError("protocol_error");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength > maximumBytes || (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)) {
    throw new RemoteSignerError("protocol_error");
  }
  if (bytes.toString("base64url") !== value) throw new RemoteSignerError("protocol_error");
  return bytes;
}

function ownKeys(value: object): string[] {
  return Object.keys(value);
}

interface DecodedResponse {
  signature: Buffer;
  attestationSignature?: Buffer;
}

function decodeResponse(body: Buffer): DecodedResponse {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(body);
  } catch {
    throw new RemoteSignerError("protocol_error");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RemoteSignerError("protocol_error");
  const response = parsed as { ok?: unknown; signature?: unknown; error?: unknown };
  const responseKeys = ownKeys(parsed);
  if (response.ok === true && (responseKeys.length === 2 || (responseKeys.length === 3 && responseKeys.includes("attestation_signature"))) && responseKeys.includes("signature")) {
    const signature = decodeBase64Url(response.signature, undefined, 4 * 1024);
    const attestationSignature = responseKeys.includes("attestation_signature")
      ? decodeBase64Url((parsed as { attestation_signature?: unknown }).attestation_signature, undefined, 4 * 1024)
      : undefined;
    return { signature, ...(attestationSignature === undefined ? {} : { attestationSignature }) };
  }
  if (response.ok === false && responseKeys.length === 2 && responseKeys.includes("error")) {
    const code = response.error;
    if (code === "unknown_key" || code === "rejected" || code === "invalid_request") {
      throw new RemoteSignerError(code);
    }
    throw new RemoteSignerError("protocol_error");
  }
  throw new RemoteSignerError("protocol_error");
}

/** Canonical evidence bytes the organisation key attests; external auditors use the same form. */
export function attestationPayload(keyId: string, attestation: Attestation, digest: Uint8Array, certificate: Uint8Array): Uint8Array {
  return jcsBytes({
    record_type: "signing_attestation",
    version: 1,
    key_id: keyId,
    attestation,
    digest: Buffer.from(digest).toString("base64url"),
    certificate_sha256: createHash("sha256").update(certificate).digest("hex"),
  });
}

/** Digest of the canonical evidence; the organisation key signs this value as the ECDSA digest. */
export function attestationPayloadDigest(keyId: string, attestation: Attestation, digest: Uint8Array, certificate: Uint8Array): Buffer {
  return createHash("sha256").update(attestationPayload(keyId, attestation, digest, certificate)).digest();
}

// A receipt proves the organisation key signed this evidence — not that the
// service ran its attestation checks. The key signs both the Fabric digest
// and the evidence digest, so a caller able to drive the socket could mint an
// equivalent receipt for a forged attestation. Receipts are therefore an
// operational record for honest clients; assurance comes from reconciling the
// service's audit log against the ledger, which is why attested deployments
// should always run with --audit-log.
function verifyAttestationReceipt(certificate: Buffer, keyId: string, attestation: Attestation, digest: Uint8Array, receipt: Buffer): boolean {
  try {
    // The organisation key signs sha256(canonical evidence) as a raw ECDSA
    // digest — verifying sha256 over the canonical bytes checks the same value.
    return verify("sha256", attestationPayload(keyId, attestation, digest, certificate), new X509Certificate(certificate).publicKey, receipt);
  } catch {
    return false;
  }
}

/**
 * Signer attestation callback that consumes the shared slot: every signing
 * request takes the freshest attestation exactly once, so a stale decision can
 * never be attached to an unrelated signing operation.
 */
export function attestationSlot(context: SigningAttestationContext): () => Attestation | undefined {
  return () => {
    const attestation = context.current;
    context.current = undefined;
    return attestation;
  };
}

/** Serialises one signer-bearing call's install→consume→clear on a shared slot. */
export type AttestationSerializer = <T>(attestation: Attestation | undefined, operation: () => Promise<T>) => Promise<T>;

const SERIALIZER_OWNER = Symbol("attestationSerializerOwner");

/**
 * Serialises [install attestation → SDK signing call → clear] on one shared
 * slot. A mutable context is only safe while every signer-bearing operation on
 * the connection holds this queue, so concurrent evaluate/status calls can
 * never overwrite or steal an in-flight decision attestation. The queue is
 * held for the whole SDK call — signer-bearing calls on a connection wait
 * behind an in-flight operation (bounded by the SDK's RPC deadlines) — and a
 * context may be claimed by exactly one serializer: two clients sharing one
 * context would interleave installs and attach the wrong decision.
 */
export function createAttestationSerializer(context: SigningAttestationContext): AttestationSerializer {
  const owned = context as SigningAttestationContext & { [SERIALIZER_OWNER]?: object };
  if (owned[SERIALIZER_OWNER] !== undefined) throw new Error("Signing attestation context is already claimed by another serializer");
  const owner = {};
  owned[SERIALIZER_OWNER] = owner;
  let queue: Promise<void> = Promise.resolve();
  const isOwner = () => owned[SERIALIZER_OWNER] === owner;
  return <T>(attestation: Attestation | undefined, operation: () => Promise<T>): Promise<T> => {
    // After releaseAttestationSerializer a reconnect may claim the context for
    // a new client; a stale serializer must fail closed rather than install an
    // attestation into a context it no longer owns.
    if (!isOwner()) return Promise.reject(new Error("Signing attestation serializer was released"));
    const run = queue.then(async () => {
      if (!isOwner()) throw new Error("Signing attestation serializer was released");
      context.current = attestation;
      try {
        return await operation();
      } finally {
        // A failed operation may never reach the signing point; never leave a
        // stale attestation for the next operation to consume.
        if (context.current === attestation) context.current = undefined;
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
}

/**
 * Runs every cleanup step even when earlier steps throw, so a failed close
 * never leaves siblings leaked. The first error surfaces after all steps ran.
 */
export function closeAllResources(operations: ReadonlyArray<() => unknown>, label: string): void {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, label);
}

/**
 * Releases a context's serializer claim at shutdown so a reconnection may
 * rebuild a serializer over the same context object. The caller must not hold
 * in-flight signer-bearing operations when releasing; any unconsumed
 * attestation is cleared so the next owner starts from an empty slot. The
 * stale serializer then fails closed: calls still queued reject instead of
 * installing into a reclaimed context, while an already-installed operation
 * reads back an empty slot and its unattested request is rejected by
 * protected keys.
 */
export function releaseAttestationSerializer(context: SigningAttestationContext): void {
  delete (context as SigningAttestationContext & { [SERIALIZER_OWNER]?: object })[SERIALIZER_OWNER];
  context.current = undefined;
}

/**
 * Create a Fabric Gateway-compatible signer callback. The supplied digest is
 * sent as-is; it is already SHA-256 hashed by the official Gateway SDK.
 */
export function createRemoteSigner(options: RemoteSignerOptions): (digest: Uint8Array) => Promise<Uint8Array> {
  assertSocketPath(options.socketPath);
  assertKeyId(options.keyId);
  if (!(options.certificate instanceof Uint8Array) || options.certificate.byteLength === 0 || options.certificate.byteLength > MAX_CERTIFICATE_BYTES) {
    throw new TypeError("A bounded signing certificate is required");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertTimeout(timeoutMs);
  const certificate = Buffer.from(options.certificate);

  return (digest: Uint8Array): Promise<Uint8Array> => {
    if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
      return Promise.reject(new RemoteSignerError("invalid_request", "A 32-byte digest is required"));
    }
    let attestation: Attestation | undefined;
    try {
      const supplied = options.attestation?.();
      attestation = supplied === undefined ? undefined : assertSigningAttestation(supplied);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      return Promise.reject(new RemoteSignerError("invalid_request", `Signing attestation is outside the supported bounds${detail}`));
    }
    const request: SignRequest = {
      operation: "sign",
      key_id: options.keyId,
      digest: Buffer.from(digest).toString("base64url"),
      certificate: certificate.toString("base64url"),
      ...(attestation === undefined ? {} : { attestation }),
    };
    return new Promise<Uint8Array>((resolve, reject) => {
      const socket = connectSocket({ path: options.socketPath });
      let received = Buffer.alloc(0);
      let settled = false;
      let expectedLength: number | undefined;
      let decoded: DecodedResponse | undefined;
      let timer: ReturnType<typeof setTimeout>;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      timer = setTimeout(() => {
        fail(new RemoteSignerError("timeout", "Signing service timed out"));
        socket.destroy();
      }, timeoutMs);
      timer.unref();
      socket.once("error", () => fail(new RemoteSignerError("service_unavailable", "Signing service is unavailable")));
      socket.once("close", () => {
        if (settled) return;
        if (decoded) {
          settled = true;
          clearTimeout(timer);
          resolve(decoded.signature);
          return;
        }
        fail(new RemoteSignerError("service_unavailable", "Signing service closed the connection"));
      });
      socket.once("end", () => {
        if (settled) return;
        if (!decoded) {
          fail(new RemoteSignerError("protocol_error"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(decoded.signature);
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        received = Buffer.concat([received, chunk]);
        if (received.byteLength > MAX_FRAME_BYTES + 4) {
          fail(new RemoteSignerError("protocol_error"));
          socket.destroy();
          return;
        }
        if (expectedLength === undefined && received.byteLength >= 4) {
          expectedLength = received.readUInt32BE(0);
          if (expectedLength === 0 || expectedLength > MAX_FRAME_BYTES || received.byteLength > expectedLength + 4) {
            fail(new RemoteSignerError("protocol_error"));
            socket.destroy();
            return;
          }
        }
        if (expectedLength !== undefined && received.byteLength === expectedLength + 4) {
          try {
            const response = decodeResponse(received.subarray(4));
            // An attested request must come back with a receipt the organisation
            // key actually signed over this exact request; otherwise the evidence
            // chain is silently absent. A receipt on an unattested request is
            // equally malformed.
            if (attestation === undefined ? response.attestationSignature !== undefined
              : response.attestationSignature === undefined
                || !verifyAttestationReceipt(certificate, options.keyId, attestation, digest, response.attestationSignature)) {
              throw new RemoteSignerError("protocol_error");
            }
            decoded = response;
            // The caller's receipt hook is not part of the signing protocol:
            // its own failure surfaces as-is rather than as a malformed
            // response, and it still fails the signing request. The hook must
            // be synchronous — a promise return would reject after the request
            // settles, escaping as an unhandled rejection instead of failing
            // this signature deterministically.
            if (attestation !== undefined && response.attestationSignature !== undefined && options.onAttestationReceipt !== undefined) {
              try {
                const returned = options.onAttestationReceipt(response.attestationSignature, attestationPayload(options.keyId, attestation, digest, certificate)) as unknown;
                if (returned !== undefined && returned !== null && typeof (returned as { then?: unknown }).then === "function") {
                  // Observe the offending promise so a later rejection cannot
                  // escape as an unhandled rejection after this request fails.
                  void Promise.resolve(returned).catch(() => {});
                  throw new RemoteSignerError("invalid_request", "The attestation receipt hook must be synchronous");
                }
              } catch (error) {
                fail(error instanceof Error ? error : new RemoteSignerError("protocol_error"));
                socket.destroy();
                return;
              }
            }
            socket.end();
          } catch (error) {
            fail(error instanceof RemoteSignerError ? error : new RemoteSignerError("protocol_error"));
            socket.destroy();
          }
        }
      });
      socket.once("connect", () => {
        try { socket.write(encodeFrame(request)); }
        catch (error) { fail(error instanceof RemoteSignerError ? error : new RemoteSignerError("protocol_error")); socket.destroy(); }
      });
    });
  };
}

export const remoteSignerLimits = Object.freeze({ maxFrameBytes: MAX_FRAME_BYTES, maxCertificateBytes: MAX_CERTIFICATE_BYTES, maxTimeoutMs: MAX_TIMEOUT_MS });
