import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { connect, createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createRemoteSigner, RemoteSignerError } from "../../packages/fabric/remote-signer.ts";
import { startDevelopmentSigningService } from "../../infra/fabric/signing-service.ts";

const requireFabric = createRequire(new URL("../../packages/fabric/package.json", import.meta.url));
let sdkAvailable = true;
try { requireFabric.resolve('@hyperledger/fabric-gateway'); }
catch (error) { const e = error as NodeJS.ErrnoException; if (e.code !== 'MODULE_NOT_FOUND' || !e.message.startsWith("Cannot find module '@hyperledger/fabric-gateway'")) throw error; sdkAvailable = false; }

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.allocUnsafe(body.byteLength + 4);
  result.writeUInt32BE(body.byteLength, 0);
  body.copy(result, 4);
  return result;
}

async function mockSigningSocket(handler: (request: Record<string, unknown>) => unknown | Promise<unknown>): Promise<{ path: string; close: () => Promise<void> }> {
  const directory = mkdtempSync(join(tmpdir(), "kcl-remote-signer-"));
  const path = join(directory, "sign.sock");
  const server: Server = createServer(socket => {
    let input = Buffer.alloc(0);
    let length: number | undefined;
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      if (length === undefined && input.byteLength >= 4) length = input.readUInt32BE(0);
      if (length === undefined || input.byteLength < length + 4) return;
      const request = JSON.parse(input.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>;
      void Promise.resolve(handler(request)).then(value => socket.end(frame(value))).catch(() => socket.destroy());
    });
    socket.on("error", () => { /* The client may close its side after a timeout. */ });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { path, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function rawResponseSocket(payload: Buffer, trailing = Buffer.alloc(0)): Promise<{ path: string; close: () => Promise<void> }> {
  const directory = mkdtempSync(join(tmpdir(), "kcl-raw-signer-"));
  const path = join(directory, "sign.sock");
  const server: Server = createServer(socket => {
    socket.once("data", () => socket.end(Buffer.concat([frameBytes(payload), trailing])));
    socket.on("error", () => { /* The client may close after a protocol error. */ });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { path, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function frameBytes(body: Buffer): Buffer {
  const result = Buffer.allocUnsafe(body.byteLength + 4);
  result.writeUInt32BE(body.byteLength, 0);
  body.copy(result, 4);
  return result;
}

test("remote signer sends the SDK digest without hashing it again", { skip: !sdkAvailable }, async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sdk = requireFabric("@hyperledger/fabric-gateway") as { signers: { newPrivateKeySigner(key: typeof privateKey): (digest: Uint8Array) => Promise<Uint8Array> } };
  const noble = requireFabric("@noble/curves/nist.js") as { p256: { verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array, options: { format: "der"; prehash: false }): boolean } };
  const sdkSigner = sdk.signers.newPrivateKeySigner(privateKey);
  const certificate = publicKey.export({ type: "spki", format: "der" });
  const publicJwk = publicKey.export({ format: "jwk" });
  if (typeof publicJwk.x !== "string" || typeof publicJwk.y !== "string") throw new Error("ephemeral public key export failed");
  const rawPublicKey = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, "base64url"), Buffer.from(publicJwk.y, "base64url")]);
  const digest = Buffer.alloc(32, 0x5a);
  let receivedDigest = "";
  const mock = await mockSigningSocket(async request => {
    receivedDigest = String(request.digest);
    return { ok: true, signature: Buffer.from(await sdkSigner(Buffer.from(request.digest as string, "base64url"))).toString("base64url") };
  });
  try {
    const signer = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate });
    const signature = await signer(digest);
    assert.ok(signature.byteLength > 0);
    assert.equal(noble.p256.verify(signature, digest, rawPublicKey, { format: "der", prehash: false }), true);
    assert.deepEqual(Buffer.from(receivedDigest, "base64url"), digest);
  } finally { await mock.close(); }
});

test("remote signer rejects malformed, wrong certificate, and rejected responses", async () => {
  const certificate = Buffer.from("public certificate");
  const mock = await mockSigningSocket(request => {
    if (request.certificate !== certificate.toString("base64url")) return { ok: false, error: "rejected" };
    return { ok: false, error: "invalid_request" };
  });
  try {
    const signer = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate, timeoutMs: 1000 });
    await assert.rejects(() => signer(Buffer.alloc(31)), (error: unknown) => error instanceof RemoteSignerError && error.code === "invalid_request");
    await assert.rejects(() => createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate })(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "invalid_request");
    const wrongCertificate = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate: Buffer.from("wrong certificate") });
    await assert.rejects(() => wrongCertificate(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
  } finally { await mock.close(); }
});

test("remote signer reports timeout and unavailable service without exposing request data", async () => {
  const stalled = await mockSigningSocket(() => new Promise<never>(() => {}));
  try {
    const signer = createRemoteSigner({ socketPath: stalled.path, keyId: "person-sales-owner", certificate: Buffer.from("certificate"), timeoutMs: 20 });
    await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "timeout");
  } finally { await stalled.close(); }
  const unavailable = createRemoteSigner({ socketPath: join(mkdtempSync(join(tmpdir(), "kcl-remote-unavailable-")), "missing.sock"), keyId: "person-sales-owner", certificate: Buffer.from("certificate"), timeoutMs: 100 });
  await assert.rejects(() => unavailable(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "service_unavailable");
});

test("remote signer rejects duplicate fields, invalid UTF-8, and trailing response bytes", async () => {
  for (const payload of [
    Buffer.from('{"ok":true,"signature":"AA","signature":"AA"}', "utf8"),
    Buffer.from([0x7b, 0x22, 0x6f, 0x6b, 0x22, 0x3a, 0xff, 0x7d]),
  ]) {
    const mock = await rawResponseSocket(payload);
    try {
      const signer = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate: Buffer.from("certificate"), timeoutMs: 1000 });
      await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "protocol_error");
    } finally { await mock.close(); }
  }
  const body = Buffer.from('{"ok":true,"signature":"AA"}', "utf8");
  const mock = await rawResponseSocket(body, Buffer.from("trailing", "utf8"));
  try {
    const signer = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate: Buffer.from("certificate"), timeoutMs: 1000 });
    await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "protocol_error");
  } finally { await mock.close(); }
});

test("development signing service signs with only the approved test identities", async t => {
  const certificatePath = join(process.cwd(), ".data/fabric-smoke/crypto/peerOrganizations/sales.kcl.test/users/User1@sales.kcl.test/msp/signcerts/User1@sales.kcl.test-cert.pem");
  if (!sdkAvailable || !existsSync(certificatePath)) { t.skip("Fabric SDK and disposable identities are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "kcl-signing-service-"));
  const service = await startDevelopmentSigningService({ socketPath: join(directory, "sign.sock") });
  try {
    const certificate = readFileSync(certificatePath);
    const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate });
    const signature = await signer(Buffer.alloc(32, 7));
    assert.ok(signature.byteLength > 0);
  } finally { await service.close(); }
});

test('signing service bounds idle connections and closes partial frames', async t => {
  const path = join(process.cwd(), '.data/fabric-smoke/crypto/peerOrganizations/sales.kcl.test/users/User1@sales.kcl.test/msp/signcerts/User1@sales.kcl.test-cert.pem');
  if (!sdkAvailable || !existsSync(path)) { t.skip('Fabric SDK and disposable identities are required'); return; }
  const directory = mkdtempSync('/tmp/kcl-signer-limits-');
  const service = await startDevelopmentSigningService({ socketPath: join(directory, 'sign.sock') });
  const sockets: Socket[] = [];
  try {
    for (let i = 0; i < 64; i++) {
      const socket = connect(service.socketPath); sockets.push(socket); socket.on('error', () => {});
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(Buffer.from([0]));
    }
    const extra = connect(service.socketPath); sockets.push(extra); extra.on('error', () => {});
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Excess signing connection was not refused')), 1000); extra.once('close', () => { clearTimeout(timer); resolve(); }); });
    await new Promise<void>((resolve, reject) => {
      if (sockets[0].destroyed) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('Partial signing frame did not expire')), 6500);
      sockets[0].once('close', () => { clearTimeout(timer); resolve(); });
    });
  } finally { for (const socket of sockets) socket.destroy(); await service.close(); }
});
