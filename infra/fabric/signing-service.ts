import { createHash, createPrivateKey, timingSafeEqual, X509Certificate, type KeyObject } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
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
    const kinds = entry.allowed_actor_kinds ?? ["human"];
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
    if (typeof actorId !== "string" || actorId.length === 0 || actorId.length > 128) return {};
    if (actorKind !== "human" && actorKind !== "agent") return {};
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
      if ((reference.org_id !== undefined || reference.require_attestation === true) && (actor.actor_id === undefined || actor.actor_kind === undefined)) {
        throw new Error(`certificate is missing the actor attributes required for attested signing${actorError === undefined ? "" : `: ${actorError}`}`);
      }
      loaded.set(reference.key_id, { certificate, validFrom, validTo, sign: sdk.signers.newPrivateKeySigner(privateKey), ...(reference.org_id === undefined ? {} : { org_id: reference.org_id }), ...actor, allowed_actor_kinds: reference.allowed_actor_kinds ?? Object.freeze(["human"]), require_attestation: reference.require_attestation === true });
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
        if (Date.now() < key.validFrom || Date.now() >= key.validTo || !compareCertificate(certificate, key.certificate)) { response(socket, { ok: false, error: "rejected" }); return; }
        const digest = base64(request.digest, 32);
        const attestation = request.attestation;
        // Attested signing always requires a configured organisation binding;
        // otherwise a caller could have any claimed organisation signed into
        // the evidence record.
        const attestationRejected = attestation === undefined
          ? key.require_attestation
          : key.org_id === undefined
            || key.actor_id !== attestation.actor_id || key.actor_kind !== attestation.actor_kind
            || key.org_id !== attestation.org_id
            || !key.allowed_actor_kinds.includes(attestation.actor_kind);
        if (attestationRejected) {
          audit?.({ record_type: "signing_rejected", version: 1, timestamp: new Date().toISOString(), key_id: request.key_id, attestation: attestation ?? null, digest: digest.toString("base64url"), certificate_sha256: createHash("sha256").update(certificate).digest("hex") });
          response(socket, { ok: false, error: "rejected" }); return;
        }
        // The Fabric digest and the attestation evidence are signed
        // independently; issuing them together keeps latency at one round.
        const [signature, attested] = await Promise.all([
          signWithTimeout(key.sign, digest),
          attestation === undefined ? Promise.resolve(undefined) : signWithTimeout(key.sign, attestationPayloadDigest(request.key_id, attestation, digest, certificate)),
        ]);
        if (Date.now() < key.validFrom || Date.now() >= key.validTo || !(signature instanceof Uint8Array) || signature.byteLength === 0 || signature.byteLength > MAX_SIGNATURE_BYTES) {
          response(socket, { ok: false, error: "rejected" }); return;
        }
        let attestationSignature: Buffer | undefined;
        if (attestation !== undefined) {
          if (!(attested instanceof Uint8Array) || attested.byteLength === 0 || attested.byteLength > MAX_SIGNATURE_BYTES) {
            response(socket, { ok: false, error: "rejected" }); return;
          }
          attestationSignature = Buffer.from(attested);
        }
        audit?.({
          record_type: attestation === undefined ? "signing" : "signing_attestation", version: 1, timestamp: new Date().toISOString(), key_id: request.key_id,
          attestation: attestation ?? null, digest: digest.toString("base64url"), certificate_sha256: createHash("sha256").update(certificate).digest("hex"),
          signature: Buffer.from(signature).toString("base64url"), ...(attestationSignature === undefined ? {} : { attestation_signature: attestationSignature.toString("base64url") }),
        });
        response(socket, { ok: true, signature: Buffer.from(signature).toString("base64url"), ...(attestationSignature === undefined ? {} : { attestation_signature: attestationSignature.toString("base64url") }) });
      } catch {
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
  // socket: check resolved paths (and inodes for existing files) against every
  // configured filesystem object.
  const resolvedAudit = resolve(path);
  for (const reserved of reservedPaths) {
    if (resolve(reserved) === resolvedAudit) throw new Error("Signing audit log path collides with a configured file");
    try {
      if (realpathSync(reserved) === realpathSync(path)) throw new Error("Signing audit log path collides with a configured file");
    } catch (error) {
      if (error instanceof Error && error.message.includes("collides")) throw error;
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
  // Open once and keep the descriptor: re-opening per record would let a
  // symlink or inode replacement slip between validation and append.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Signing audit log must be a regular file with mode 600");
  } catch (error) {
    closeSync(fd);
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
    },
    close: () => { if (!closed) { closed = true; closeSync(fd); } },
  };
}

export async function startSigningService(options: { socketPath: string; keys: readonly SigningKeyReference[]; auditLogPath?: string }): Promise<SigningService> {
  const socketPath = options.socketPath;
  if (typeof socketPath !== "string" || socketPath.length === 0 || !isAbsolute(socketPath) || socketPath.includes("\u0000") || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new TypeError("A valid Unix socket path is required");
  if (pathAlreadyExists(socketPath)) throw new Error("Signing socket already exists; refusing to replace it");
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentMode = lstatSync(parent).mode & 0o777;
  if (parentMode !== 0o700) throw new Error("Signing socket parent directory must be mode 700");
  const references = assertKeyReferences(options.keys);
  const keys = loadKeys(references);
  const auditLog = options.auditLogPath === undefined ? undefined : openAuditLog(options.auditLogPath, [socketPath, ...references.flatMap(reference => [reference.certificate_path, reference.private_key_path])]);
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
  let service: SigningService;
  if (demo) {
    const wrapper = await import("../../examples/order-workflow/signing-service.ts");
    service = await wrapper.startDevelopmentSigningService({ socketPath, keyIds: demoKeyId === undefined ? undefined : [demoKeyId], auditLogPath });
  } else {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), configPath!), "utf8")) as unknown;
    const references = Array.isArray(config) ? config : (config && typeof config === "object" && "keys" in config ? (config as { keys: unknown }).keys : undefined);
    if (!Array.isArray(references)) throw new Error("Signing key configuration must be an array or an object with keys");
    service = await startSigningService({ socketPath, keys: references as SigningKeyReference[], auditLogPath });
  }
  const stop = (): void => { void service.close().finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Signing service could not start. Check the explicit key references and socket path.\n"); process.exitCode = 1; });
}
