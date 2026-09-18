import { createHash, createPrivateKey, timingSafeEqual, X509Certificate, type KeyObject } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "../../packages/fabric/canonical.ts";
import { assertSigningAttestation, attestationPayloadDigest, type Attestation } from "../../packages/fabric/remote-signer.ts";

const MAX_FRAME_BYTES = 32 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 4 * 1024;
const MAX_CONCURRENCY = 16;
const MAX_CONNECTIONS = 64;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_SOCKET_PATH_BYTES = 104;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;

const requireFabric = createRequire(new URL("../../packages/fabric/package.json", import.meta.url));

interface FabricSigners {
  newPrivateKeySigner(key: KeyObject): (digest: Uint8Array) => Promise<Uint8Array>;
}

interface FabricGatewayModule {
  signers: FabricSigners;
}

interface LoadedKey {
  certificate: Buffer;
  validFrom: number;
  validTo: number;
  sign: (digest: Uint8Array) => Promise<Uint8Array>;
  org_id?: string;
  actor_id?: string;
  actor_kind?: "human" | "agent";
  allowed_actor_kinds: readonly ("human" | "agent")[];
  require_attestation: boolean;
}

export interface SigningKeyReference {
  key_id: string;
  certificate_path: string;
  private_key_path: string;
  /** Organisation the key attests for; required before any attested signing is accepted. */
  org_id?: string;
  /** Actor kinds permitted for attested signing; defaults to human-only. */
  allowed_actor_kinds?: readonly ("human" | "agent")[];
  /** When true, requests without an attestation are rejected. Requires org_id. */
  require_attestation?: boolean;
}

interface SignRequest {
  operation: "sign";
  key_id: string;
  digest: string;
  certificate: string;
  attestation?: Attestation;
}

interface SignResponse {
  ok: true;
  signature: string;
  attestation_signature?: string;
}

interface ErrorResponse {
  ok: false;
  error: "invalid_request" | "unknown_key" | "rejected";
}

export interface DevelopmentSigningService {
  readonly socketPath: string;
  close(): Promise<void>;
}

export type SigningService = DevelopmentSigningService;

function ownKeys(value: object): string[] {
  return Object.keys(value);
}

function frame(value: SignResponse | ErrorResponse): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.allocUnsafe(4 + body.byteLength);
  result.writeUInt32BE(body.byteLength, 0);
  body.copy(result, 4);
  return result;
}

function response(socket: Socket, value: SignResponse | ErrorResponse): void {
  try { socket.end(frame(value)); } catch { socket.destroy(); }
}

function base64(value: unknown, exactBytes?: number, maxBytes = MAX_FRAME_BYTES): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid request");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength > maxBytes || (exactBytes !== undefined && bytes.byteLength !== exactBytes)) throw new Error("invalid request");
  if (bytes.toString("base64url") !== value) throw new Error("invalid request");
  return bytes;
}

function parseRequest(body: Buffer): SignRequest {
  let value: unknown;
  try { value = parseStrictJson(body); } catch { throw new Error("invalid request"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid request");
  const request = value as Partial<SignRequest>;
  const keys = ownKeys(value);
  const attested = keys.includes("attestation");
  if (keys.length !== (attested ? 5 : 4) || !keys.includes("operation") || !keys.includes("key_id") || !keys.includes("digest") || !keys.includes("certificate") || request.operation !== "sign") {
    throw new Error("invalid request");
  }
  if (typeof request.key_id !== "string" || !KEY_ID_PATTERN.test(request.key_id)) throw new Error("unknown key");
  base64(request.digest, 32);
  base64(request.certificate, undefined, MAX_CERTIFICATE_BYTES);
  try {
    const attestation = attested ? assertSigningAttestation(request.attestation) : undefined;
    return { operation: "sign", key_id: request.key_id, digest: request.digest as string, certificate: request.certificate as string, ...(attestation === undefined ? {} : { attestation }) };
  } catch { throw new Error("invalid request"); }
}

function assertKeyReferences(value: readonly SigningKeyReference[]): readonly SigningKeyReference[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new TypeError("Signing key references must be a non-empty bounded array");
  const ids = new Set<string>();
  return Object.freeze(value.map((entry) => {
    if (!entry || typeof entry !== "object" || !KEY_ID_PATTERN.test(entry.key_id) || ids.has(entry.key_id)
      || typeof entry.certificate_path !== "string" || !isAbsolute(entry.certificate_path)
      || typeof entry.private_key_path !== "string" || !isAbsolute(entry.private_key_path)) {
      throw new TypeError("Signing key references must contain unique absolute paths and safe IDs");
    }
    const kinds: readonly ("human" | "agent")[] = entry.allowed_actor_kinds ?? ["human"];
    if (entry.org_id !== undefined && (typeof entry.org_id !== "string" || entry.org_id.length === 0 || entry.org_id.length > 128)
      || !Array.isArray(kinds) || kinds.length === 0 || kinds.length > 2 || new Set(kinds).size !== kinds.length
      || kinds.some(kind => kind !== "human" && kind !== "agent")
      || (entry.require_attestation !== undefined && typeof entry.require_attestation !== "boolean")
      || (entry.require_attestation === true && entry.org_id === undefined)) {
      throw new TypeError("Signing key references must contain a bounded organisation and actor-kind allowlist; required attestation needs an organisation binding");
    }
    ids.add(entry.key_id);
    return { key_id: entry.key_id, certificate_path: entry.certificate_path, private_key_path: entry.private_key_path, ...(entry.org_id === undefined ? {} : { org_id: entry.org_id }), allowed_actor_kinds: Object.freeze([...kinds]), require_attestation: entry.require_attestation === true };
  }));
}

function certificateActor(certificate: Buffer): { actor_id?: string; actor_kind?: "human" | "agent"; error?: string } {
  try {
    const { ClientIdentity } = requireFabric("fabric-shim") as { ClientIdentity: new (stub: unknown) => { getAttributeValue(name: string): string | null } };
    const identity = new ClientIdentity({ getCreator: () => ({ mspid: "", idBytes: certificate }), getChannelID: () => "", getTxID: () => "signing-service-validation" });
    const actorId = identity.getAttributeValue("kcl.actor_id");
    const actorKind = identity.getAttributeValue("kcl.actor_kind");
    if (actorId === null && actorKind === null) return {};
    if (typeof actorId !== "string" || actorId.length === 0 || actorId.length > 128) return { error: "kcl.actor_id is absent or outside the supported bounds" };
    if (actorKind !== "human" && actorKind !== "agent") return { error: "kcl.actor_kind is absent or outside the supported bounds" };
    return { actor_id: actorId, actor_kind: actorKind };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

function loadKeys(references: readonly SigningKeyReference[]): Map<string, LoadedKey> {
  const sdk = requireFabric("@hyperledger/fabric-gateway") as FabricGatewayModule;
  const loaded = new Map<string, LoadedKey>();
  for (const reference of references) {
    try {
      const certificate = readFileSync(reference.certificate_path);
      if (certificate.byteLength === 0 || certificate.byteLength > MAX_CERTIFICATE_BYTES) throw new Error("invalid certificate");
      const x509 = new X509Certificate(certificate);
      const validFrom = Date.parse(x509.validFrom);
      const validTo = Date.parse(x509.validTo);
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || Date.now() < validFrom || Date.now() >= validTo) throw new Error("expired certificate");
      const privateKey = createPrivateKey(readFileSync(reference.private_key_path));
      if (!x509.checkPrivateKey(privateKey)) throw new Error("certificate and key do not match");
      const { error: actorError, ...actor } = certificateActor(certificate);
      // A key that serves attested requests must be able to bind its actor
      // attributes; failing here distinguishes misconfiguration from a rejected
      // attestation at request time.
      const attested = reference.org_id !== undefined || reference.require_attestation === true;
      if (attested && (actor.actor_id === undefined || actor.actor_kind === undefined)) {
        throw new Error(`certificate is missing the actor attributes required for attested signing${actorError === undefined ? "" : `: ${actorError}`}`);
      }
      const allowedActorKinds: readonly ("human" | "agent")[] = reference.allowed_actor_kinds ?? Object.freeze(["human"]);
      if (attested && actor.actor_kind !== undefined && !allowedActorKinds.includes(actor.actor_kind)) {
        throw new Error("certificate actor_kind is outside the configured allowed_actor_kinds");
      }
      // Attestation receipts are verified as ECDSA over sha256(canonical
      // evidence); non-EC keys (e.g. Ed25519) cannot produce them.
      if (attested && privateKey.asymmetricKeyType !== "ec") {
        throw new Error("attested signing requires an EC private key");
      }
      loaded.set(reference.key_id, { certificate, validFrom, validTo, sign: sdk.signers.newPrivateKeySigner(privateKey), ...(reference.org_id === undefined ? {} : { org_id: reference.org_id }), ...actor, allowed_actor_kinds: allowedActorKinds, require_attestation: reference.require_attestation === true });
    } catch (error) { throw new Error("Configured signing identity is invalid", { cause: error }); }
  }
  return loaded;
}

function compareCertificate(received: Buffer, expected: Buffer): boolean {
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

function pathAlreadyExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ENOENT";
  }
}

interface AttestationAudit {
  (record: Record<string, unknown>): void;
}

async function serveSocket(socket: Socket, keys: Map<string, LoadedKey>, acquire: () => boolean, release: () => void, audit?: AttestationAudit): Promise<void> {
  let input = Buffer.alloc(0);
  let length: number | undefined;
  let handled = false;
  socket.setNoDelay(true);
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  const reject = (error: Error): void => response(socket, { ok: false, error: error.message === "unknown key" ? "unknown_key" : "invalid_request" });
  socket.on("data", chunk => {
    if (handled) return;
    input = Buffer.concat([input, chunk]);
    if (input.byteLength > MAX_FRAME_BYTES + 4) { handled = true; reject(new Error("invalid request")); return; }
    if (length === undefined && input.byteLength >= 4) {
      length = input.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) { handled = true; reject(new Error("invalid request")); return; }
    }
    if (length === undefined || input.byteLength < length + 4) return;
    if (input.byteLength !== length + 4) { handled = true; reject(new Error("invalid request")); return; }
    handled = true;
    let request: SignRequest;
    try { request = parseRequest(input.subarray(4)); }
    catch (error) { reject(error instanceof Error ? error : new Error("invalid request")); return; }
    const key = keys.get(request.key_id);
    if (!key) { response(socket, { ok: false, error: "unknown_key" }); return; }
    if (!acquire()) { response(socket, { ok: false, error: "rejected" }); return; }
    void (async () => {
      try {
        const certificate = base64(request.certificate, undefined, MAX_CERTIFICATE_BYTES);
        if (Date.now() < key.validFrom || Date.now() >= key.validTo || !compareCertificate(certificate, key.certificate)) {
          audit?.({ record_type: "signing_rejected", reason: "certificate_mismatch", version: 1, timestamp: new Date().toISOString(), key_id: request.key_id, attestation: request.attestation ?? null, phase: request.attestation?.phase ?? null, certificate_sha256: createHash("sha256").update(certificate).digest("hex"), certificate_actor: { actor_id: key.actor_id ?? null, actor_kind: key.actor_kind ?? null } });
          response(socket, { ok: false, error: "rejected" }); return;
        }
        const digest = base64(request.digest, 32);
        const attestation = request.attestation;
        // Attested signing always requires a configured organisation binding;
        // otherwise a caller could have any claimed organisation signed into
        // the evidence record. The service sees an opaque digest, so the
        // attested phase and command binding are caller-asserted claims
        // countersigned into evidence — it cannot prove which Fabric operation
        // the digest belongs to, and a caller able to drive this endpoint can
        // mint equivalent bytes, so a receipt is an operational record for
        // honest clients rather than independent verification. Auditors
        // reconcile each record's tx_id/digest against the ledger (a write
        // signed under a "query" claim leaves no attested tx_id), and an
        // operational gateway re-derives the binding from proposal bytes.
        const attestationRejected = attestation === undefined
          ? key.require_attestation
          : key.org_id === undefined
            || key.actor_id !== attestation.actor_id || key.actor_kind !== attestation.actor_kind
            || key.org_id !== attestation.org_id
            || !key.allowed_actor_kinds.includes(attestation.actor_kind);
        if (attestationRejected) {
          audit?.({ record_type: "signing_rejected", reason: "attestation_rejected", version: 1, timestamp: new Date().toISOString(), key_id: request.key_id, attestation: attestation ?? null, phase: attestation?.phase ?? null, digest: digest.toString("base64url"), certificate_sha256: createHash("sha256").update(certificate).digest("hex"), certificate_actor: { actor_id: key.actor_id ?? null, actor_kind: key.actor_kind ?? null } });
          response(socket, { ok: false, error: "rejected" }); return;
        }
        // Compute the evidence digest before starting either signature: an
        // exception here must not orphan an in-flight signing operation. One
        // request slot covers both signatures deliberately — an attested
        // request is a single logical signing operation.
        const evidenceDigest = attestation === undefined ? undefined : attestationPayloadDigest(request.key_id, attestation, digest, certificate);
        // The Fabric digest and the attestation evidence are signed
        // independently; issuing them together keeps latency at one round.
        const [signature, attested] = await Promise.all([
          signWithTimeout(key.sign, digest),
          evidenceDigest === undefined ? Promise.resolve(undefined) : signWithTimeout(key.sign, evidenceDigest),
        ]);
        if (Date.now() < key.validFrom || Date.now() >= key.validTo || !(signature instanceof Uint8Array) || signature.byteLength === 0 || signature.byteLength > MAX_SIGNATURE_BYTES) {
          // The key already produced a signature: a post-sign rejection still
          // needs a record so key use and the audit log cannot diverge.
          audit?.({ record_type: "signing_rejected", reason: "signature_invalid", version: 1, timestamp: new Date().toISOString(), key_id: request.key_id, attestation: attestation ?? null, phase: attestation?.phase ?? null, digest: digest.toString("base64url"), certificate_sha256: createHash("sha256").update(certificate).digest("hex"), certificate_actor: { actor_id: key.actor_id ?? null, actor_kind: key.actor_kind ?? null } });
          response(socket, { ok: false, error: "rejected" }); return;
        }
        let attestationSignature: Buffer | undefined;
        if (attestation !== undefined) {
          if (!(attested instanceof Uint8Array) || attested.byteLength === 0 || attested.byteLength > MAX_SIGNATURE_BYTES) {
            audit?.({ record_type: "signing_rejected", reason: "attestation_signature_invalid", version: 1, timestamp: new Date().toISOString(), key_id: request.key_id, attestation: attestation ?? null, phase: attestation?.phase ?? null, digest: digest.toString("base64url"), certificate_sha256: createHash("sha256").update(certificate).digest("hex"), certificate_actor: { actor_id: key.actor_id ?? null, actor_kind: key.actor_kind ?? null } });
            response(socket, { ok: false, error: "rejected" }); return;
          }
          attestationSignature = Buffer.from(attested);
        }
        audit?.({
          record_type: attestation === undefined ? "signing" : "signing_attestation", version: 1, timestamp: new Date().toISOString(), key_id: request.key_id,
          attestation: attestation ?? null, phase: attestation?.phase ?? null, digest: digest.toString("base64url"), certificate_sha256: createHash("sha256").update(certificate).digest("hex"),
          signature: Buffer.from(signature).toString("base64url"), ...(attestationSignature === undefined ? {} : { attestation_signature: attestationSignature.toString("base64url") }),
        });
        response(socket, { ok: true, signature: Buffer.from(signature).toString("base64url"), ...(attestationSignature === undefined ? {} : { attestation_signature: attestationSignature.toString("base64url") }) });
      } catch {
        // A signing exception or timeout may still have invoked the key;
        // record the failure best-effort (the audit write itself may be the
        // cause, so it must not throw here).
        try { audit?.({ record_type: "signing_rejected", reason: "signing_failed", version: 1, timestamp: new Date().toISOString(), key_id: request.key_id, attestation: request.attestation ?? null, phase: request.attestation?.phase ?? null }); } catch { /* audit may itself be the failure */ }
        response(socket, { ok: false, error: "rejected" });
      } finally { release(); }
    })();
  });
  socket.on("error", () => { /* Client disconnects are expected during timeout recovery. */ });
}

async function signWithTimeout(sign: (digest: Uint8Array) => Promise<Uint8Array>, digest: Uint8Array): Promise<Uint8Array> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sign(digest),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("signing timeout")), REQUEST_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const MAX_AUDIT_PATH_BYTES = 1024;

interface AuditLog {
  audit: AttestationAudit;
  close(): void;
}

function openAuditLog(path: string, reservedPaths: readonly string[]): AuditLog {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path) || path.includes("\u0000") || Buffer.byteLength(path) > MAX_AUDIT_PATH_BYTES) throw new TypeError("A valid audit log path is required");
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentMode = lstatSync(parent).mode & 0o777;
  if (parentMode !== 0o700) throw new Error("Signing audit log parent directory must be mode 700");
  // Audit appends must never land on key material, certificates or the service
  // socket: check resolved paths against every configured filesystem object.
  const resolvedAudit = resolve(path);
  let realAudit: string | undefined;
  try { realAudit = realpathSync(path); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  for (const reserved of reservedPaths) {
    if (resolve(reserved) === resolvedAudit) throw new Error("Signing audit log path collides with a configured file");
    if (realAudit === undefined) continue;
    let realReserved: string;
    try {
      realReserved = realpathSync(reserved);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
    if (realReserved === realAudit) throw new Error("Signing audit log path collides with a configured file");
  }
  // A pre-existing non-regular target (FIFO, socket, device) must fail before
  // open: O_WRONLY on a FIFO would block forever waiting for a reader.
  let preexisting = true;
  try {
    if (!lstatSync(path).isFile()) throw new Error("Signing audit log must be a regular file with mode 600");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    preexisting = false;
  }
  // Open once and keep the descriptor: re-opening per record would let a
  // symlink or inode replacement slip between validation and append.
  // O_NONBLOCK closes the lstat→open window in which a swapped FIFO would
  // otherwise block the open; it has no effect on regular-file writes.
  // O_EXCL on a fresh path turns the lstat→open race into an error instead of
  // opening (and later unlinking) a file another process created meanwhile.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | (preexisting ? 0 : constants.O_EXCL), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Signing audit log must be a regular file with mode 600");
    // Path equality cannot catch a hard link, so compare the opened inode
    // itself against every reserved file that exists on disk.
    for (const reserved of reservedPaths) {
      let target;
      try {
        target = statSync(reserved);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw error;
      }
      if (target.dev === stat.dev && target.ino === stat.ino) throw new Error("Signing audit log path collides with a configured file");
    }
    // nlink > 1 means another name reaches the same inode: audit appends would
    // corrupt whatever that link points at even when it is not a configured
    // file, so only single-link targets are accepted.
    if (stat.nlink !== 1) throw new Error("Signing audit log must be a regular file with a single link");
  } catch (error) {
    closeSync(fd);
    // A file this call created must not linger after failed validation.
    if (!preexisting) try { unlinkSync(path); } catch { /* best-effort cleanup */ }
    throw error;
  }
  let closed = false;
  return {
    audit: record => {
      // In-flight handlers may finish after close(); writing then could hit a
      // reused descriptor, so late records are dropped instead.
      if (closed) return;
      const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      let written = 0;
      while (written < line.byteLength) written += writeSync(fd, line.subarray(written));
      // Durably flush before the caller is acknowledged: a crash between a
      // signed response and this record landing would leave an attested
      // signature with no matching evidence.
      fsyncSync(fd);
    },
    close: () => { if (!closed) { closed = true; closeSync(fd); } },
  };
}

export async function startSigningService(options: { socketPath: string; keys: readonly SigningKeyReference[]; auditLogPath?: string; reservedPaths?: readonly string[] }): Promise<SigningService> {
  const socketPath = options.socketPath;
  if (typeof socketPath !== "string" || socketPath.length === 0 || !isAbsolute(socketPath) || socketPath.includes("\u0000") || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new TypeError("A valid Unix socket path is required");
  if (pathAlreadyExists(socketPath)) throw new Error("Signing socket already exists; refusing to replace it");
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentMode = lstatSync(parent).mode & 0o777;
  if (parentMode !== 0o700) throw new Error("Signing socket parent directory must be mode 700");
  const references = assertKeyReferences(options.keys);
  // Attested signing without a service-side audit log leaves the evidence
  // chain empty: receipts alone cannot prove these checks ran, so the sink
  // that auditors reconcile against the ledger is mandatory, not advisory.
  if (options.auditLogPath === undefined && references.some(reference => reference.require_attestation === true)) {
    throw new Error("Attested signing keys require an audit log: pass --audit-log so the service records the evidence chain");
  }
  const keys = loadKeys(references);
  const auditLog = options.auditLogPath === undefined ? undefined : openAuditLog(options.auditLogPath, [socketPath, ...(options.reservedPaths ?? []), ...references.flatMap(reference => [reference.certificate_path, reference.private_key_path])]);
  let active = 0;
  const connections = new Set<Socket>();
  const server: Server = createServer(socket => {
    if (connections.size >= MAX_CONNECTIONS) {
      response(socket, { ok: false, error: "rejected" });
      return;
    }
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    void serveSocket(socket, keys, () => {
      if (active >= MAX_CONCURRENCY) return false;
      active += 1;
      return true;
    }, () => { active -= 1; }, auditLog?.audit);
  });
  server.maxConnections = MAX_CONNECTIONS;
  let owned = false;
  let ownedSocket: { dev: number; ino: number } | undefined;
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
    let onListening: () => void;
    const onError = (error: Error & { code?: string }): void => { server.off("listening", onListening); rejectReady(new Error(error.code === "EADDRINUSE" ? "Signing socket is already in use" : "Signing service failed to listen")); };
    onListening = (): void => {
      try {
        chmodSync(socketPath, 0o600);
        const stat = lstatSync(socketPath);
        if (!stat.isSocket()) throw new Error("not a socket");
        ownedSocket = { dev: stat.dev, ino: stat.ino };
        owned = true;
        server.off("error", onError);
        resolveReady();
      }
      catch { server.close(); rejectReady(new Error("Signing service failed to secure its socket")); }
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
    });
  } catch (error) {
    auditLog?.close();
    throw error;
  }
  let closed = false;
  return {
    socketPath,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const connection of connections) connection.destroy();
      await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
      auditLog?.close();
      if (owned) {
        try {
          const stat = lstatSync(socketPath);
          if (stat.isSocket() && ownedSocket && stat.dev === ownedSocket.dev && stat.ino === ownedSocket.ino) unlinkSync(socketPath);
        } catch { /* The socket may already have been removed by the operating system. */ }
        owned = false;
        ownedSocket = undefined;
      }
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let socketPath: string | undefined;
  let configPath: string | undefined;
  let auditLogPath: string | undefined;
  let demo = false;
  let demoKeyId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    if (option === "--demo") {
      if (demo || configPath) throw new Error("Choose exactly one of --config or --demo");
      demo = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Signing service options require values');
    if (option === '--socket' && socketPath === undefined) socketPath = value;
    else if (option === '--config' && configPath === undefined) configPath = value;
    else if (option === '--audit-log' && auditLogPath === undefined) auditLogPath = value;
    else if (option === '--key-id' && demoKeyId === undefined) demoKeyId = value;
    else throw new Error('Unknown or duplicate signing service option');
  }
  if (!socketPath || (!demo && !configPath) || (demo && configPath) || (!demo && demoKeyId !== undefined)) {
    throw new Error('Usage: signing-service.ts --socket ABSOLUTE_UNIX_SOCKET_PATH (--config KEY_REFS_JSON | --demo) [--key-id ID] [--audit-log ABSOLUTE_PATH]');
  }
  // Resolve like --config so a relative audit path fails the same validation
  // instead of surfacing as an internal TypeError from openAuditLog.
  if (auditLogPath !== undefined) auditLogPath = resolve(process.cwd(), auditLogPath);
  let service: SigningService;
  if (demo) {
    const wrapper = await import("../../examples/order-workflow/signing-service.ts");
    service = await wrapper.startDevelopmentSigningService({ socketPath, keyIds: demoKeyId === undefined ? undefined : [demoKeyId], auditLogPath });
  } else {
    const resolvedConfig = resolve(process.cwd(), configPath!);
    const config = JSON.parse(readFileSync(resolvedConfig, "utf8")) as unknown;
    const references = Array.isArray(config) ? config : (config && typeof config === "object" && "keys" in config ? (config as { keys: unknown }).keys : undefined);
    if (!Array.isArray(references)) throw new Error("Signing key configuration must be an array or an object with keys");
    // The configuration file itself is reserved: an audit path colliding with
    // it would corrupt the next start.
    service = await startSigningService({ socketPath, keys: references as SigningKeyReference[], auditLogPath, reservedPaths: [resolvedConfig] });
  }
  const stop = (): void => { void service.close().finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Signing service could not start. Check the explicit key references and socket path.\n"); process.exitCode = 1; });
}
