import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from 'node:fs';
import { connect, createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { startSigningService } from "../../infra/fabric/signing-service.ts";
import { jcsBytes } from "../../packages/fabric/canonical.ts";
import { createRemoteSigner, RemoteSignerError, type SigningAttestation } from "../../packages/fabric/remote-signer.ts";
import { startDevelopmentSigningService, type DevelopmentSigningKeyId } from "../../examples/order-workflow/signing-service.ts";

const requireFabric = createRequire(new URL("../../packages/fabric/package.json", import.meta.url));
let sdkAvailable = true;
try { requireFabric.resolve('@hyperledger/fabric-gateway'); }
catch (error) { const e = error as NodeJS.ErrnoException; if (e.code !== 'MODULE_NOT_FOUND' || !e.message.startsWith("Cannot find module '@hyperledger/fabric-gateway'")) throw error; sdkAvailable = false; }

test('running signer rejects a certificate at its expiration boundary', async t => {
  if (!sdkAvailable || spawnSync('openssl', ['version']).status !== 0) { t.skip('Fabric SDK and OpenSSL are required'); return; }
  const directory = mkdtempSync('/tmp/knowledger-signer-expiry-');
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'certificate.pem');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const issued = spawnSync('openssl', ['req', '-new', '-x509', '-key', keyPath, '-subj', '/CN=synthetic-expiry-test', '-days', '1', '-out', certificatePath], { stdio: 'ignore' });
  assert.equal(issued.status, 0, 'synthetic certificate issuance succeeds');
  const certificate = readFileSync(certificatePath);
  const service = await startSigningService({ socketPath: join(directory, 'sign.sock'), keys: [{ key_id: 'synthetic-owner', certificate_path: certificatePath, private_key_path: keyPath }] });
  try {
    const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: 'synthetic-owner', certificate });
    assert.ok((await signer(Buffer.alloc(32, 19))).byteLength > 0);
    t.mock.method(Date, 'now', () => Date.parse(new X509Certificate(certificate).validTo));
    await assert.rejects(signer(Buffer.alloc(32, 20)), (error: unknown) => error instanceof RemoteSignerError && error.code === 'rejected');
  } finally { t.mock.restoreAll(); await service.close(); fs.rmSync(directory, { recursive: true }); }
});

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.allocUnsafe(body.byteLength + 4);
  result.writeUInt32BE(body.byteLength, 0);
  body.copy(result, 4);
  return result;
}

async function mockSigningSocket(handler: (request: Record<string, unknown>) => unknown | Promise<unknown>): Promise<{ path: string; close: () => Promise<void> }> {
  const directory = mkdtempSync(join(tmpdir(), "knowledger-remote-signer-"));
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
  const directory = mkdtempSync(join(tmpdir(), "knowledger-raw-signer-"));
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

test("remote signer accepts generic safe key IDs and rejects unsafe IDs", async () => {
  const certificate = Buffer.from("public certificate");
  const mock = await mockSigningSocket(request => ({ ok: true, signature: Buffer.from(String(request.key_id)).toString("base64url") }));
  try {
    const signer = createRemoteSigner({ socketPath: mock.path, keyId: "org_alpha.owner-01", certificate });
    assert.deepEqual(await signer(Buffer.alloc(32)), Buffer.from("org_alpha.owner-01"));
    for (const keyId of ["ab", "bad/key", "é-owner", "x".repeat(129)]) {
      assert.throws(() => createRemoteSigner({ socketPath: mock.path, keyId, certificate }), /key ID/i);
    }
  } finally { await mock.close(); }
});

test("remote signer reports timeout and unavailable service without exposing request data", async () => {
  const stalled = await mockSigningSocket(() => new Promise<never>(() => {}));
  try {
    const signer = createRemoteSigner({ socketPath: stalled.path, keyId: "person-sales-owner", certificate: Buffer.from("certificate"), timeoutMs: 20 });
    await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "timeout");
  } finally { await stalled.close(); }
  const unavailable = createRemoteSigner({ socketPath: join(mkdtempSync(join(tmpdir(), "knowledger-remote-unavailable-")), "missing.sock"), keyId: "person-sales-owner", certificate: Buffer.from("certificate"), timeoutMs: 100 });
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
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-service-"));
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
  const directory = mkdtempSync('/tmp/knowledger-signer-limits-');
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

test('scoped signer reads only the selected organization identity and refuses every other key', async t => {
  const certificatePath = join(process.cwd(), '.data/fabric-smoke/crypto/peerOrganizations/sales.kcl.test/users/User1@sales.kcl.test/msp/signcerts/User1@sales.kcl.test-cert.pem');
  if (!sdkAvailable || !existsSync(certificatePath)) { t.skip('Fabric SDK and disposable identities are required'); return; }
  const originalRead = fs.readFileSync;
  const accessed: string[] = [];
  t.mock.method(fs, 'readFileSync', (path: any, ...args: any[]) => {
    if (String(path).includes('/crypto/')) {
      assert.ok(String(path).includes('/sales.kcl.test/'), 'unselected identity must not be read');
      accessed.push(String(path));
    }
    return (originalRead as any)(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const keyIds: DevelopmentSigningKeyId[] = ['person-sales-owner'];
  const directory = mkdtempSync('/tmp/knowledger-scoped-signer-');
  const service = await startDevelopmentSigningService({ socketPath: join(directory, 'sign.sock'), keyIds });
  try {
    keyIds.push('person-settlement-owner');
    const certificate = originalRead(certificatePath);
    const digest = Buffer.alloc(32, 11);
    const signature = await createRemoteSigner({ socketPath: service.socketPath, keyId: 'person-sales-owner', certificate })(digest);
    const publicJwk = new X509Certificate(certificate).publicKey.export({ format: 'jwk' });
    const rawPublicKey = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, 'base64url'), Buffer.from(publicJwk.y!, 'base64url')]);
    const { p256 } = requireFabric('@noble/curves/nist.js');
    assert.equal(p256.verify(signature, digest, rawPublicKey, { format: 'der', prehash: false }), true);
    for (const keyId of ['person-settlement-owner', 'person-fulfillment-owner'] as const) {
      await assert.rejects(createRemoteSigner({ socketPath: service.socketPath, keyId, certificate })(digest),
        (error: unknown) => error instanceof RemoteSignerError && error.code === 'unknown_key');
    }
    assert.ok(accessed.length >= 2);
  } finally { await service.close(); }
});

test('signer rejects empty, duplicate and unknown key allowlists before opening the service', async () => {
  const directory = mkdtempSync('/tmp/knowledger-invalid-signer-');
  for (const keyIds of [[], ['person-sales-owner', 'person-sales-owner'], ['unknown-key'], null]) {
    await assert.rejects(async () => {
      const service = await startDevelopmentSigningService({ socketPath: join(directory, 'sign.sock'), keyIds } as any);
      await service.close();
    }, (error: unknown) => error instanceof TypeError);
  }
});

function devAttestation(overrides: Partial<SigningAttestation> = {}): SigningAttestation {
  return {
    org_id: "SalesMSP",
    actor_id: "person-sales-owner",
    actor_kind: "human",
    command_id: "cmd-attested",
    command_type: "approve_revision",
    command_digest: `sha256:${"ab".repeat(32)}`,
    phase: "submit",
    tx_id: "tx-attested",
    ...overrides,
  };
}

test("remote signer sends the decision attestation and accepts its receipt", async () => {
  const certificate = Buffer.from("public certificate");
  const attestation = devAttestation();
  let received: Record<string, unknown> | undefined;
  const mock = await mockSigningSocket(async request => {
    received = request;
    return { ok: true, signature: Buffer.from("sig").toString("base64url"), attestation_signature: Buffer.from("att").toString("base64url") };
  });
  try {
    const signer = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate, attestation: () => attestation });
    assert.deepEqual(await signer(Buffer.alloc(32)), Buffer.from("sig"));
    assert.deepEqual(received?.attestation, attestation);
  } finally { await mock.close(); }
});

test("remote signer rejects an out-of-bounds attestation before connecting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "knowledger-attestation-bounds-"));
  const socketPath = join(directory, "sign.sock");
  for (const broken of [
    devAttestation({ command_digest: "not-a-digest" }),
    devAttestation({ actor_kind: "service" as never }),
    devAttestation({ phase: "endorse" as never }),
    { ...devAttestation(), extra: "field" },
    { ...devAttestation(), org_id: "" },
  ]) {
    const signer = createRemoteSigner({ socketPath, keyId: "person-sales-owner", certificate: Buffer.from("certificate"), attestation: () => broken });
    await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "invalid_request");
  }
});

test("remote signer rejects malformed attestation receipts", async () => {
  const certificate = Buffer.from("public certificate");
  for (const payload of [
    { ok: true, signature: Buffer.from("sig").toString("base64url"), attestation_signature: "!!!" },
    { ok: true, signature: Buffer.from("sig").toString("base64url"), extra_receipt: "AA" },
  ]) {
    const mock = await mockSigningSocket(async () => payload);
    try {
      const signer = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate, attestation: () => devAttestation(), timeoutMs: 1000 });
      await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "protocol_error");
    } finally { await mock.close(); }
  }
});

function developmentSigningKey(): { certificate_path: string; private_key_path: string } | undefined {
  const msp = join(process.cwd(), ".data/fabric-smoke/crypto/peerOrganizations/sales.kcl.test/users/User1@sales.kcl.test/msp");
  const certificate_path = join(msp, "signcerts", "User1@sales.kcl.test-cert.pem");
  if (!existsSync(certificate_path)) return undefined;
  const keys = readdirSync(join(msp, "keystore")).filter(name => name.endsWith("_sk"));
  if (keys.length !== 1) return undefined;
  return { certificate_path, private_key_path: join(msp, "keystore", keys[0]) };
}

test("signing service attests a bound human decision and records an audit receipt", async t => {
  const key = developmentSigningKey();
  if (!sdkAvailable || !key) { t.skip("Fabric SDK and disposable identities are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-attestation-"));
  const auditLogPath = join(directory, "audit.jsonl");
  const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", ...key, org_id: "SalesMSP" }], auditLogPath });
  try {
    const certificate = readFileSync(key.certificate_path);
    const attestation = devAttestation();
    const digest = Buffer.alloc(32, 21);
    const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate, attestation: () => attestation });
    const signature = await signer(digest);
    const publicJwk = new X509Certificate(certificate).publicKey.export({ format: "jwk" });
    const rawPublicKey = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, "base64url"), Buffer.from(publicJwk.y!, "base64url")]);
    const { p256 } = requireFabric("@noble/curves/nist.js");
    assert.equal(p256.verify(signature, digest, rawPublicKey, { format: "der", prehash: false }), true);
    const records = readFileSync(auditLogPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.record_type, "signing_attestation");
    assert.equal(record.key_id, "person-sales-owner");
    assert.deepEqual(record.attestation, attestation);
    assert.equal(record.digest, digest.toString("base64url"));
    const payloadDigest = createHash("sha256").update(jcsBytes({
      record_type: "signing_attestation", version: 1, key_id: "person-sales-owner", attestation,
      digest: digest.toString("base64url"), certificate_sha256: createHash("sha256").update(certificate).digest("hex"),
    })).digest();
    assert.equal(p256.verify(Buffer.from(record.attestation_signature, "base64url"), payloadDigest, rawPublicKey, { format: "der", prehash: false }), true);
  } finally { await service.close(); }
});

test("signing service rejects attestations that do not match the bound identity", async t => {
  const key = developmentSigningKey();
  if (!sdkAvailable || !key) { t.skip("Fabric SDK and disposable identities are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-attestation-reject-"));
  const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", ...key, org_id: "SalesMSP" }] });
  try {
    const certificate = readFileSync(key.certificate_path);
    for (const broken of [
      devAttestation({ actor_id: "person-other-owner" }),
      devAttestation({ org_id: "OtherMSP" }),
      devAttestation({ actor_kind: "agent" }),
    ]) {
      const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate, attestation: () => broken });
      await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
    }
    const withoutOrg = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate, attestation: () => devAttestation() });
    assert.ok((await withoutOrg(Buffer.alloc(32, 22))).byteLength > 0);
  } finally { await service.close(); }
});

async function rawSignRequest(path: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let input = Buffer.alloc(0);
    let length: number | undefined;
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      if (length === undefined && input.byteLength >= 4) length = input.readUInt32BE(0);
      if (length === undefined || input.byteLength < length + 4) return;
      resolve(JSON.parse(input.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>);
    });
    socket.on("error", reject);
    socket.on("connect", () => socket.write(frame(request)));
  });
}

test("signing service rejects malformed attestations as invalid requests", async t => {
  const key = developmentSigningKey();
  if (!sdkAvailable || !key) { t.skip("Fabric SDK and disposable identities are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-attestation-invalid-"));
  const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", ...key }] });
  try {
    const certificate = readFileSync(key.certificate_path);
    const request = (attestation: unknown) => ({ operation: "sign", key_id: "person-sales-owner", digest: Buffer.alloc(32).toString("base64url"), certificate: certificate.toString("base64url"), attestation });
    const { tx_id: _txId, ...withoutTx } = devAttestation();
    const { phase: _phase, ...withoutPhase } = withoutTx;
    for (const attestation of [
      { ...devAttestation(), command_digest: "bad" },
      { ...devAttestation(), extra: "field" },
      withoutPhase,
      "not-an-object",
    ]) {
      assert.deepEqual(await rawSignRequest(service.socketPath, request(attestation)), { ok: false, error: "invalid_request" });
    }
  } finally { await service.close(); }
});
