import { createPrivateKey, timingSafeEqual, X509Certificate, type KeyObject } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { createRequire } from "node:module";
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "../../packages/fabric/canonical.ts";

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
  sign: (digest: Uint8Array) => Promise<Uint8Array>;
}

export interface SigningKeyReference {
  key_id: string;
  certificate_path: string;
  private_key_path: string;
}

interface SignRequest {
  operation: "sign";
  key_id: string;
  digest: string;
  certificate: string;
}

interface SignResponse {
  ok: true;
  signature: string;
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
  if (keys.length !== 4 || !keys.includes("operation") || !keys.includes("key_id") || !keys.includes("digest") || !keys.includes("certificate") || request.operation !== "sign") {
    throw new Error("invalid request");
  }
  if (typeof request.key_id !== "string" || !KEY_ID_PATTERN.test(request.key_id)) throw new Error("unknown key");
  base64(request.digest, 32);
  base64(request.certificate, undefined, MAX_CERTIFICATE_BYTES);
  return request as SignRequest;
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
    ids.add(entry.key_id);
    return { key_id: entry.key_id, certificate_path: entry.certificate_path, private_key_path: entry.private_key_path };
  }));
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
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || Date.now() < validFrom || Date.now() > validTo) throw new Error("expired certificate");
      const privateKey = createPrivateKey(readFileSync(reference.private_key_path));
      if (!x509.checkPrivateKey(privateKey)) throw new Error("certificate and key do not match");
      loaded.set(reference.key_id, { certificate, sign: sdk.signers.newPrivateKeySigner(privateKey) });
    } catch { throw new Error("Configured signing identity is invalid"); }
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

async function serveSocket(socket: Socket, keys: Map<string, LoadedKey>, acquire: () => boolean, release: () => void): Promise<void> {
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
        if (!compareCertificate(certificate, key.certificate)) { response(socket, { ok: false, error: "rejected" }); return; }
        const digest = base64(request.digest, 32);
        const signature = await signWithTimeout(key.sign, digest);
        if (!(signature instanceof Uint8Array) || signature.byteLength === 0 || signature.byteLength > MAX_SIGNATURE_BYTES) {
          response(socket, { ok: false, error: "rejected" }); return;
        }
        response(socket, { ok: true, signature: Buffer.from(signature).toString("base64url") });
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

export async function startSigningService(options: { socketPath: string; keys: readonly SigningKeyReference[] }): Promise<SigningService> {
  const socketPath = options.socketPath;
  if (typeof socketPath !== "string" || socketPath.length === 0 || !isAbsolute(socketPath) || socketPath.includes("\u0000") || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new TypeError("A valid Unix socket path is required");
  if (pathAlreadyExists(socketPath)) throw new Error("Signing socket already exists; refusing to replace it");
  const parent = dirname(socketPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentMode = lstatSync(parent).mode & 0o777;
  if (parentMode !== 0o700) throw new Error("Signing socket parent directory must be mode 700");
  const keys = loadKeys(assertKeyReferences(options.keys));
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
    }, () => { active -= 1; });
  });
  server.maxConnections = MAX_CONNECTIONS;
  let owned = false;
  let ownedSocket: { dev: number; ino: number } | undefined;
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
  let closed = false;
  return {
    socketPath,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const connection of connections) connection.destroy();
      await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
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
    else if (option === '--key-id' && demoKeyId === undefined) demoKeyId = value;
    else throw new Error('Unknown or duplicate signing service option');
  }
  if (!socketPath || (!demo && !configPath) || (demo && configPath) || (!demo && demoKeyId !== undefined)) {
    throw new Error('Usage: signing-service.ts --socket ABSOLUTE_UNIX_SOCKET_PATH (--config KEY_REFS_JSON | --demo) [--key-id ID]');
  }
  let service: SigningService;
  if (demo) {
    const wrapper = await import("../../examples/order-workflow/signing-service.ts");
    service = await wrapper.startDevelopmentSigningService({ socketPath, keyIds: demoKeyId === undefined ? undefined : [demoKeyId] });
  } else {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), configPath!), "utf8")) as unknown;
    const references = Array.isArray(config) ? config : (config && typeof config === "object" && "keys" in config ? (config as { keys: unknown }).keys : undefined);
    if (!Array.isArray(references)) throw new Error("Signing key configuration must be an array or an object with keys");
    service = await startSigningService({ socketPath, keys: references as SigningKeyReference[] });
  }
  const stop = (): void => { void service.close().finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Signing service could not start. Check the explicit key references and socket path.\n"); process.exitCode = 1; });
}
