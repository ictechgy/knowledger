import { connect as connectSocket } from "node:net";
import { isAbsolute } from "node:path";
import { parseStrictJson } from "./canonical.ts";

const MAX_FRAME_BYTES = 32 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_SOCKET_PATH_BYTES = 104;

export type SigningKeyId = string;

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
}

interface SignRequest {
  operation: "sign";
  key_id: SigningKeyId;
  digest: string;
  certificate: string;
}

interface SignResponse {
  ok: true;
  signature: string;
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

function decodeResponse(body: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(body);
  } catch {
    throw new RemoteSignerError("protocol_error");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RemoteSignerError("protocol_error");
  const response = parsed as { ok?: unknown; signature?: unknown; error?: unknown };
  if (response.ok === true && ownKeys(parsed).length === 2 && ownKeys(parsed).includes("signature")) {
    return decodeBase64Url(response.signature, undefined, 4 * 1024);
  }
  if (response.ok === false && ownKeys(parsed).length === 2 && ownKeys(parsed).includes("error")) {
    const code = response.error;
    if (code === "unknown_key" || code === "rejected" || code === "invalid_request") {
      throw new RemoteSignerError(code);
    }
    throw new RemoteSignerError("protocol_error");
  }
  throw new RemoteSignerError("protocol_error");
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
    const request: SignRequest = {
      operation: "sign",
      key_id: options.keyId,
      digest: Buffer.from(digest).toString("base64url"),
      certificate: certificate.toString("base64url"),
    };
    return new Promise<Uint8Array>((resolve, reject) => {
      const socket = connectSocket({ path: options.socketPath });
      let received = Buffer.alloc(0);
      let settled = false;
      let expectedLength: number | undefined;
      let decodedSignature: Buffer | undefined;
      let timer: ReturnType<typeof setTimeout>;
      const fail = (error: RemoteSignerError): void => {
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
        if (decodedSignature) {
          settled = true;
          clearTimeout(timer);
          resolve(decodedSignature);
          return;
        }
        fail(new RemoteSignerError("service_unavailable", "Signing service closed the connection"));
      });
      socket.once("end", () => {
        if (settled) return;
        if (!decodedSignature) {
          fail(new RemoteSignerError("protocol_error"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(decodedSignature);
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
            decodedSignature = decodeResponse(received.subarray(4));
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
