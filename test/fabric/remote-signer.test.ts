import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign, verify, X509Certificate } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from 'node:fs';
import { connect, createServer, type Server, type Socket } from "node:net";
import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { startSigningService } from "../../infra/fabric/signing-service.ts";
import { attestationPayload, attestationPayloadDigest, attestationSlot, createAttestationSerializer, createRemoteSigner, releaseAttestationSerializer, RemoteSignerError, type Attestation, type QueryAttestation, type SigningAttestation, type SigningAttestationContext } from "../../packages/fabric/remote-signer.ts";
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

function devQueryAttestation(overrides: Partial<QueryAttestation> = {}): QueryAttestation {
  return { org_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human", phase: "query", ...overrides };
}

test("development signing service signs with only the approved test identities", async t => {
  const certificatePath = join(process.cwd(), ".data/fabric-smoke/crypto/peerOrganizations/sales.kcl.test/users/User1@sales.kcl.test/msp/signcerts/User1@sales.kcl.test-cert.pem");
  if (!sdkAvailable || !existsSync(certificatePath)) { t.skip("Fabric SDK and disposable identities are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-service-"));
  const service = await startDevelopmentSigningService({ socketPath: join(directory, "sign.sock") });
  try {
    const certificate = readFileSync(certificatePath);
    // Development keys require attestation; an unattested request is refused.
    const raw = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate });
    await assert.rejects(() => raw(Buffer.alloc(32, 7)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
    const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate, attestation: () => devQueryAttestation() });
    const signature = await signer(Buffer.alloc(32, 7));
    assert.ok(signature.byteLength > 0);
  } finally { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("development signing service derives its audit log beside the socket when none is given", async t => {
  const certificatePath = join(process.cwd(), ".data/fabric-smoke/crypto/peerOrganizations/sales.kcl.test/users/User1@sales.kcl.test/msp/signcerts/User1@sales.kcl.test-cert.pem");
  if (!sdkAvailable || !existsSync(certificatePath)) { t.skip("Fabric SDK and disposable identities are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-derived-audit-"));
  const service = await startDevelopmentSigningService({ socketPath: join(directory, "sign.sock") });
  try {
    t.after(() => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* cleanup best-effort */ } });
    const certificate = readFileSync(certificatePath);
    const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate, attestation: () => devQueryAttestation() });
    await signer(Buffer.alloc(32, 3));
    // The derived log must actually record the attested signing evidence at
    // the documented location — signing-audit/audit.jsonl beside the socket.
    const derived = join(directory, "signing-audit", "audit.jsonl");
    assert.ok(existsSync(derived), "derived audit log exists beside the socket");
    const records = readFileSync(derived, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const signed = records.find(record => record.record_type === "signing_attestation");
    // A query-phase record must carry the read-only shape auditors reconcile:
    // phase "query" and none of the decision-only command/tx_id fields.
    const attestation = signed?.attestation as Record<string, unknown> | undefined;
    assert.equal(attestation?.phase, "query");
    assert.equal(signed?.phase, "query");
    assert.equal(attestation !== undefined && !("command_id" in attestation) && !("tx_id" in attestation), true, "query records carry no decision-only fields");
  } finally { await service.close(); }
});

test("development signing service attests each approved organisation binding and refuses cross-organisation claims", async t => {
  const certFor = (org: string) => join(process.cwd(), `.data/fabric-smoke/crypto/peerOrganizations/${org}.kcl.test/users/User1@${org}.kcl.test/msp/signcerts/User1@${org}.kcl.test-cert.pem`);
  const paths = { sales: certFor("sales"), fulfillment: certFor("fulfillment"), settlement: certFor("settlement") };
  if (!sdkAvailable || !Object.values(paths).every(existsSync)) { t.skip("Fabric SDK and disposable identities are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-service-orgs-"));
  const service = await startDevelopmentSigningService({ socketPath: join(directory, "sign.sock") });
  try {
    const bindings: Array<{ keyId: DevelopmentSigningKeyId; org: string; msp: string }> = [
      { keyId: "person-sales-owner", org: "sales", msp: "SalesMSP" },
      { keyId: "person-fulfillment-owner", org: "fulfillment", msp: "FulfillmentMSP" },
      { keyId: "person-settlement-owner", org: "settlement", msp: "SettlementMSP" },
    ];
    for (const [index, binding] of bindings.entries()) {
      const certificate = readFileSync(paths[binding.org as keyof typeof paths]);
      const attestation = () => ({ org_id: binding.msp, actor_id: binding.keyId, actor_kind: "human" as const, phase: "query" as const });
      const signature = await createRemoteSigner({ socketPath: service.socketPath, keyId: binding.keyId, certificate, attestation })(Buffer.alloc(32, 9));
      assert.ok(signature.byteLength > 0, `${binding.keyId} signs its own organisation query attestation`);
      // A certificate claiming another organisation's binding is refused; each
      // binding is tested against a genuinely different organisation claim.
      const foreign = bindings[(index + 1) % bindings.length];
      const cross = createRemoteSigner({ socketPath: service.socketPath, keyId: binding.keyId, certificate, attestation: () => ({ org_id: foreign.msp, actor_id: binding.keyId, actor_kind: "human" as const, phase: "query" as const }) });
      await assert.rejects(() => cross(Buffer.alloc(32, 9)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
    }
  } finally { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); }
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
    const signature = await createRemoteSigner({ socketPath: service.socketPath, keyId: 'person-sales-owner', certificate, attestation: () => devQueryAttestation() })(digest);
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

/** Signs the canonical evidence the way the organisation key does: ECDSA over sha256(evidence). */
function evidenceSign(evidence: Uint8Array, privateKey: ReturnType<typeof createPrivateKey>): Buffer {
  return sign("sha256", evidence, privateKey);
}

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

const opensslAvailable = (): boolean => spawnSync('openssl', ['version']).status === 0;

/** Self-signed certificate carrying the same kcl.actor_* attribute encoding the development fixture uses. */
function generateAttestedIdentity(directory: string, attrs: Record<string, string>, keyType: "ec" | "ed25519" = "ec", name = attrs["kcl.actor_id"] ?? "identity"): { certificate_path: string; private_key_path: string; certificate: Buffer } {
  const privateKeyPath = join(directory, `key-${name}-${keyType}.pem`);
  const certificatePath = join(directory, `cert-${name}-${keyType}.pem`);
  const configPath = join(directory, `openssl-${name}-${keyType}.cnf`);
  const { privateKey } = keyType === "ec" ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('ed25519');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const attrsHex = Buffer.from(JSON.stringify({ attrs }), 'utf8').toString('hex');
  fs.writeFileSync(configPath, `oid_section = oids\n[ req ]\ndistinguished_name = dn\n[ dn ]\n[ oids ]\nkclAttrs = 1.2.3.4.5.6.7.8.1\n[ v3 ]\nkclAttrs = DER:${attrsHex}\n`, { mode: 0o600 });
  const issued = spawnSync('openssl', ['req', '-new', '-x509', '-key', privateKeyPath, '-subj', '/CN=kcl-attested-test', '-days', '1', '-config', configPath, '-extensions', 'v3', '-out', certificatePath], { stdio: 'ignore' });
  assert.equal(issued.status, 0, 'attested test certificate issuance succeeds');
  return { certificate_path: certificatePath, private_key_path: privateKeyPath, certificate: readFileSync(certificatePath) };
}

test("remote signer sends the decision attestation and verifies its receipt", async t => {
  if (!opensslAvailable()) { t.skip("OpenSSL is required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-attested-signer-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const privateKey = createPrivateKey(readFileSync(identity.private_key_path));
    const attestation = devAttestation();
    const digest = Buffer.alloc(32, 5);
    let received: Record<string, unknown> | undefined;
    const mock = await mockSigningSocket(async request => {
      received = request;
      const requestDigest = Buffer.from(String(request.digest), "base64url");
      const receipt = evidenceSign(attestationPayload(String(request.key_id), request.attestation as Attestation, requestDigest, Buffer.from(String(request.certificate), "base64url")), privateKey);
      return { ok: true, signature: sign("sha256", requestDigest, privateKey).toString("base64url"), attestation_signature: receipt.toString("base64url") };
    });
    try {
      const signer = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => attestation });
      const signature = await signer(digest);
      assert.deepEqual(received?.attestation, attestation);
      assert.equal(verify("sha256", digest, new X509Certificate(identity.certificate).publicKey, signature), true);
    } finally { await mock.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("remote signer rejects an out-of-bounds attestation before connecting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "knowledger-attestation-bounds-"));
  try {
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
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("remote signer rejects malformed attestation receipts", async t => {
  if (!opensslAvailable()) { t.skip("OpenSSL is required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-attested-receipts-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    for (const payload of [
      { ok: true, signature: Buffer.from("sig").toString("base64url"), attestation_signature: "!!!" },
      { ok: true, signature: Buffer.from("sig").toString("base64url"), extra_receipt: "AA" },
    ]) {
      const mock = await mockSigningSocket(async () => payload);
      try {
        const signer = createRemoteSigner({ socketPath: mock.path, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => devAttestation(), timeoutMs: 1000 });
        await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "protocol_error");
      } finally { await mock.close(); }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("remote signer requires a verified attestation receipt", async t => {
  if (!opensslAvailable()) { t.skip("OpenSSL is required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-receipt-required-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const privateKey = createPrivateKey(readFileSync(identity.private_key_path));
    // Missing receipt: an attested request answered without attestation_signature.
    const silent = await mockSigningSocket(async request => {
      const requestDigest = Buffer.from(String(request.digest), "base64url");
      return { ok: true, signature: sign("sha256", requestDigest, privateKey).toString("base64url") };
    });
    try {
      const signer = createRemoteSigner({ socketPath: silent.path, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => devAttestation(), timeoutMs: 1000 });
      await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "protocol_error");
    } finally { await silent.close(); }
    // Forged receipt: a receipt over different evidence is not accepted.
    const forged = await mockSigningSocket(async request => {
      const requestDigest = Buffer.from(String(request.digest), "base64url");
      const receipt = evidenceSign(attestationPayload(String(request.key_id), devAttestation({ command_id: "cmd-other" }), requestDigest, Buffer.from(String(request.certificate), "base64url")), privateKey);
      return { ok: true, signature: sign("sha256", requestDigest, privateKey).toString("base64url"), attestation_signature: receipt.toString("base64url") };
    });
    try {
      const signer = createRemoteSigner({ socketPath: forged.path, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => devAttestation(), timeoutMs: 1000 });
      await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "protocol_error");
    } finally { await forged.close(); }
    // Unattested requests still accept a plain signature response.
    const plain = await mockSigningSocket(async request => {
      const requestDigest = Buffer.from(String(request.digest), "base64url");
      return { ok: true, signature: sign("sha256", requestDigest, privateKey).toString("base64url") };
    });
    try {
      const signer = createRemoteSigner({ socketPath: plain.path, keyId: "person-sales-owner", certificate: identity.certificate });
      assert.ok((await signer(Buffer.alloc(32))).byteLength > 0);
    } finally { await plain.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service attests a bound human decision and records an audit receipt", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-attestation-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const auditLogPath = join(directory, "audit.jsonl");
    const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP", require_attestation: true }], auditLogPath });
    try {
      const certificate = identity.certificate;
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
      assert.equal(p256.verify(Buffer.from(record.attestation_signature, "base64url"), attestationPayloadDigest("person-sales-owner", attestation, digest, certificate), rawPublicKey, { format: "der", prehash: false }), true);
    } finally { await service.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service rejects attestations that do not match the bound identity", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-attestation-reject-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }], auditLogPath: join(directory, "audit.jsonl")});
    try {
      const certificate = identity.certificate;
      for (const broken of [
        devAttestation({ actor_id: "person-other-owner" }),
        devAttestation({ org_id: "OtherMSP" }),
        devAttestation({ actor_kind: "agent" }),
      ]) {
        const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate, attestation: () => broken });
        await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
      }
      const matchingIdentity = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate, attestation: () => devAttestation() });
      assert.ok((await matchingIdentity(Buffer.alloc(32, 22))).byteLength > 0);
    } finally { await service.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service enforces required attestation and organisation binding", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-required-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [
      { key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP", require_attestation: true },
      { key_id: "person-orgless-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path },
    ], auditLogPath: join(directory, "audit.jsonl") });
    try {
      // A required key refuses an unattested request.
      const raw = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate: identity.certificate });
      await assert.rejects(() => raw(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
      // Attested signing on a key without an organisation binding is refused.
      const orgless = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-orgless-owner", certificate: identity.certificate, attestation: () => devAttestation() });
      await assert.rejects(() => orgless(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
      // The same key still serves legacy unattested signing.
      assert.ok((await createRemoteSigner({ socketPath: service.socketPath, keyId: "person-orgless-owner", certificate: identity.certificate })(Buffer.alloc(32, 9))).byteLength > 0);
      // A read-only query attestation is accepted on the required key.
      const query = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => devQueryAttestation() });
      assert.ok((await query(Buffer.alloc(32, 10))).byteLength > 0);
    } finally { await service.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service audits a rejected attestation attempt", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-audit-reject-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const auditLogPath = join(directory, "audit.jsonl");
    const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP", require_attestation: true }], auditLogPath });
    try {
      const raw = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate: identity.certificate });
      await assert.rejects(() => raw(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
      const records = readFileSync(auditLogPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.length, 1);
      assert.equal(records[0].record_type, "signing_rejected");
      assert.equal(records[0].reason, "attestation_rejected");
      assert.equal(records[0].attestation, null);
      assert.equal(records[0].certificate_actor.actor_id, "person-sales-owner");
    } finally { await service.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service audits a certificate mismatch with certificate evidence", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-audit-mismatch-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const other = generateAttestedIdentity(directory, { "kcl.actor_id": "person-other", "kcl.actor_kind": "human" }, "ec", "person-other");
    const auditLogPath = join(directory, "audit.jsonl");
    const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP", require_attestation: true }], auditLogPath });
    try {
      // The caller presents a different certificate than the configured one:
      // the audit must record what the configured certificate claims.
      const raw = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate: other.certificate, attestation: () => devQueryAttestation({ actor_id: "person-other" }) });
      await assert.rejects(() => raw(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
      const records = readFileSync(auditLogPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.length, 1);
      assert.equal(records[0].record_type, "signing_rejected");
      assert.equal(records[0].reason, "certificate_mismatch");
      assert.equal(records[0].certificate_actor.actor_id, "person-sales-owner");
      assert.equal(records[0].attestation.actor_id, "person-other");
    } finally { await service.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service refuses require_attestation without an organisation binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-norg-"));
  try {
    // Configuration validation precedes key loading, so the unusable
    // combination is rejected before certificate files are even read.
    await assert.rejects(
      () => startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: join(directory, "cert.pem"), private_key_path: join(directory, "key.pem"), require_attestation: true }] }),
      (error: unknown) => error instanceof Error && error.message.includes("organisation binding"),
    );
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service refuses attested keys without an audit log", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-noaudit-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    // Receipts alone cannot prove the service ran its checks, so the
    // evidence sink is mandatory when any key requires attestation.
    await assert.rejects(
      () => startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP", require_attestation: true }] }),
      (error: unknown) => error instanceof Error && /audit log/.test(error.message),
    );
    // An organisation-bound key can also serve attested requests, so it
    // cannot start without the log either.
    await assert.rejects(
      () => startSigningService({ socketPath: join(directory, "sign2.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }] }),
      (error: unknown) => error instanceof Error && /audit log/.test(error.message),
    );
    // A key with no organisation binding serves only unattested requests and
    // still starts without the log.
    const service = await startSigningService({ socketPath: join(directory, "sign3.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path }] });
    await service.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a second serializer cannot claim an attestation context", () => {
  const context: SigningAttestationContext = {};
  createAttestationSerializer(context);
  assert.throws(
    () => createAttestationSerializer(context),
    (error: unknown) => error instanceof Error && error.message.includes("claimed by another serializer"),
  );
});

test("releaseAttestationSerializer lets a later serializer reclaim the context", async () => {
  const context: SigningAttestationContext = {};
  const first = createAttestationSerializer(context);
  releaseAttestationSerializer(context, first);
  // Reclaiming after release mirrors a reconnect: the new serializer must
  // install and serialise attestations normally.
  const reclaimed = createAttestationSerializer(context);
  const attestation = devAttestation();
  assert.equal(await reclaimed(attestation, async () => context.current), attestation);
  assert.equal(context.current, undefined);
  // Releasing a serializer that no longer owns the context is a no-op: a
  // repeated close from an old client must not evict the live claim.
  releaseAttestationSerializer(context, first);
  assert.equal(await reclaimed(attestation, async () => context.current), attestation);
  // Releasing the actual owner clears the claim; releasing again is a no-op.
  releaseAttestationSerializer(context, reclaimed);
  releaseAttestationSerializer(context, reclaimed);
});

test("a released serializer fails closed instead of touching a reclaimed context", async () => {
  const context: SigningAttestationContext = {};
  const stale = createAttestationSerializer(context);
  // Queue an operation, then release before its serialised section runs: the
  // pending call must reject rather than install into a context it no longer
  // owns, and a later reconnect claims the slot cleanly.
  const pending = stale(devAttestation(), async () => { await new Promise(resolve => setTimeout(resolve, 20)); return context.current; });
  releaseAttestationSerializer(context);
  await assert.rejects(pending, (error: unknown) => error instanceof Error && /released/.test(error.message));
  const reclaimed = createAttestationSerializer(context);
  const fresh = devAttestation();
  assert.equal(await reclaimed(fresh, async () => context.current), fresh);
  assert.equal(context.current, undefined);
});

/** Real paths currently held open by this process (Linux /proc or lsof). */
function openFileTargets(): string[] | undefined {
  const realpath = (target: string): string => { try { return fs.realpathSync(target); } catch { return target; } };
  try {
    return readdirSync("/proc/self/fd")
      .map(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return undefined; } })
      .filter((target): target is string => target !== undefined)
      .map(realpath);
  } catch { /* /proc is unavailable outside Linux. */ }
  const listed = spawnSync("lsof", ["-p", String(process.pid), "-F", "n"], { encoding: "utf8" });
  if (listed.status === 0) {
    return listed.stdout.split("\n").filter(line => line.startsWith("n")).map(line => realpath(line.slice(1)));
  }
  return undefined;
}

test("signing service closes the audit descriptor on shutdown", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-audit-close-"));
  let service: Awaited<ReturnType<typeof startSigningService>> | undefined;
  // Keep close() in the cleanup path even when an assertion fails: a running
  // service would pin the test process open.
  t.after(async () => { await service?.close(); });
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const auditLogPath = join(directory, "audit.jsonl");
    service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP", require_attestation: true }], auditLogPath });
    const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => devQueryAttestation() });
    assert.ok((await signer(Buffer.alloc(32, 12))).byteLength > 0);
    const auditRealPath = fs.realpathSync(auditLogPath);
    const targetsWhileOpen = openFileTargets();
    if (targetsWhileOpen === undefined) t.diagnostic("open-descriptor listing unsupported; fd assertions skipped");
    else assert.ok(targetsWhileOpen.includes(auditRealPath), "audit file is held open while the service runs");
    await service.close();
    assert.ok(readFileSync(auditLogPath, "utf8").includes("signing_attestation"));
    const targetsAfterClose = openFileTargets();
    if (targetsAfterClose !== undefined) assert.ok(!targetsAfterClose.includes(auditRealPath), "audit descriptor is released on close");
    await service.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service rejects hard-linked and non-regular audit paths", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-audit-hard-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const keys = [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }];
    // A hard link has a different resolved path but the same inode: opening it
    // for appends would still corrupt the key file.
    const hardLink = join(directory, "audit-hardlink.jsonl");
    linkSync(identity.private_key_path, hardLink);
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "sign.sock"), keys, auditLogPath: hardLink }), /collides/);
    // A FIFO would block O_WRONLY forever; the pre-open check must refuse it.
    const fifo = join(directory, "audit.fifo");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "sign2.sock"), keys, auditLogPath: fifo }), /regular file/);
    // A symlink to the private key resolves onto the reserved path and is
    // refused before open; the key must stay byte-identical.
    const keyBefore = readFileSync(identity.private_key_path);
    const keyLink = join(directory, "audit-key-link.jsonl");
    symlinkSync(identity.private_key_path, keyLink);
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "sign3.sock"), keys, auditLogPath: keyLink }), /collides|regular file/);
    assert.deepEqual(readFileSync(identity.private_key_path), keyBefore);
    // A symlink to an ordinary file is still refused: O_NOFOLLOW rejects the
    // final-component link even when its target is not reserved.
    const ordinary = join(directory, "ordinary.jsonl");
    fs.writeFileSync(ordinary, "", { mode: 0o600 });
    const ordinaryLink = join(directory, "audit-link.jsonl");
    symlinkSync(ordinary, ordinaryLink);
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "sign4.sock"), keys, auditLogPath: ordinaryLink }), /collides|regular file|ELOOP|symlink/i);
    assert.equal(readFileSync(ordinary, "utf8"), "");
    // A dangling symlink is not a regular file and must be refused.
    const dangling = join(directory, "audit-dangling.jsonl");
    symlinkSync(join(directory, "missing-target"), dangling);
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "sign5.sock"), keys, auditLogPath: dangling }), /collides|regular file|ELOOP|symlink/i);
    // A well-formed file that is hard-linked to an unrelated name still has
    // nlink > 1: appends would corrupt whatever the other link points at.
    const aliased = join(directory, "audit-aliased.jsonl");
    fs.writeFileSync(aliased, "", { mode: 0o600 });
    linkSync(aliased, join(directory, "audit-alias-other.jsonl"));
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "sign6.sock"), keys, auditLogPath: aliased }), /single link|collides|regular file/);
    // A pre-existing file with a permissive mode is refused; the same path at
    // mode 600 is adopted and appended to. chmod after creation so the mode
    // does not depend on the process umask.
    const wrongMode = join(directory, "audit-wrong-mode.jsonl");
    fs.writeFileSync(wrongMode, "", { mode: 0o644 });
    fs.chmodSync(wrongMode, 0o644);
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "sign7.sock"), keys, auditLogPath: wrongMode }), /regular file|mode 600/);
    fs.chmodSync(wrongMode, 0o600);
    const adopted = await startSigningService({ socketPath: join(directory, "sign8.sock"), keys, auditLogPath: wrongMode });
    await adopted.close();
    assert.equal(readFileSync(wrongMode, "utf8"), "");
    // A pre-existing log ending mid-record is refused: appending after a
    // partial line would merge two records into one unparseable JSONL line.
    const torn = join(directory, "audit-torn.jsonl");
    fs.writeFileSync(torn, '{"record_type":"signing","key_id":"person-sales', { mode: 0o600 });
    fs.chmodSync(torn, 0o600);
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "sign9.sock"), keys, auditLogPath: torn }), /newline-terminated/);
    // A properly terminated pre-existing log is adopted as before.
    fs.writeFileSync(torn, '{"record_type":"signing"}\n', { mode: 0o600 });
    fs.chmodSync(torn, 0o600);
    const adoptedTorn = await startSigningService({ socketPath: join(directory, "sign10.sock"), keys, auditLogPath: torn });
    await adoptedTorn.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service rejects an audit path that collides with configured files", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-audit-collision-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    // Each iteration gets a fresh socket path so rejection can only come from
    // the audit-path collision check, never a leftover socket bind.
    const cases: Array<[string, string]> = [
      [identity.private_key_path, "s1.sock"],
      [identity.certificate_path, "s2.sock"],
    ];
    for (const [auditLogPath, socketName] of cases) {
      await assert.rejects(() => startSigningService({ socketPath: join(directory, socketName), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }], auditLogPath }), /collides/);
    }
    // The socket path itself is reserved too: pointing the audit log at the
    // very socket the service would bind is rejected before listening.
    const socketPath = join(directory, "s3.sock");
    await assert.rejects(() => startSigningService({ socketPath, keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }], auditLogPath: socketPath }), /collides/);
    // The signing configuration file is likewise reserved so audit appends
    // can never overwrite the service's own configuration.
    const configPath = join(directory, "signing-config.json");
    fs.writeFileSync(configPath, "{}", { mode: 0o600 });
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "s4.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }], auditLogPath: configPath, reservedPaths: [configPath] }), /collides/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service enforces the actor-kind allowlist for attested signing", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-kinds-"));
  try {
    const agentIdentity = generateAttestedIdentity(directory, { "kcl.actor_id": "agent-worker", "kcl.actor_kind": "agent" });
    const humanIdentity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    // A certificate whose actor_kind can never satisfy the allowlist is a
    // configuration error: the service fails fast instead of serving a key
    // whose every attested request would be rejected.
    const invalidCause = (pattern: RegExp) => (error: unknown) => error instanceof Error && error.message === "Configured signing identity is invalid" && pattern.test(String((error.cause as Error | undefined)?.message));
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "strict.sock"), keys: [{ key_id: "agent-worker", certificate_path: agentIdentity.certificate_path, private_key_path: agentIdentity.private_key_path, org_id: "SalesMSP" }], auditLogPath: join(directory, "audit.jsonl")}), invalidCause(/allowed_actor_kinds/));
    await assert.rejects(() => startSigningService({ socketPath: join(directory, "agent-only.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: humanIdentity.certificate_path, private_key_path: humanIdentity.private_key_path, org_id: "SalesMSP", allowed_actor_kinds: ["agent"] }], auditLogPath: join(directory, "audit.jsonl") }), invalidCause(/allowed_actor_kinds/));
    // An explicit allowlist admits the same attestation for both phases.
    const permissive = await startSigningService({ socketPath: join(directory, "permissive.sock"), keys: [{ key_id: "agent-worker", certificate_path: agentIdentity.certificate_path, private_key_path: agentIdentity.private_key_path, org_id: "SalesMSP", allowed_actor_kinds: ["agent"] }], auditLogPath: join(directory, "audit.jsonl") });
    try {
      const decided = createRemoteSigner({ socketPath: permissive.socketPath, keyId: "agent-worker", certificate: agentIdentity.certificate, attestation: () => devAttestation({ actor_id: "agent-worker", actor_kind: "agent" }) });
      assert.ok((await decided(Buffer.alloc(32, 13))).byteLength > 0);
      const queried = createRemoteSigner({ socketPath: permissive.socketPath, keyId: "agent-worker", certificate: agentIdentity.certificate, attestation: () => devQueryAttestation({ actor_id: "agent-worker", actor_kind: "agent" }) });
      assert.ok((await queried(Buffer.alloc(32, 14))).byteLength > 0);
      // ...but an attestation claiming a different kind is still rejected.
      const impersonating = createRemoteSigner({ socketPath: permissive.socketPath, keyId: "agent-worker", certificate: agentIdentity.certificate, attestation: () => devAttestation({ actor_id: "agent-worker", actor_kind: "human" }) });
      await assert.rejects(() => impersonating(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
    } finally { await permissive.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service refuses non-EC keys for attested signing", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-ed25519-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" }, "ed25519");
    // Attestation receipts are ECDSA evidence; an Ed25519 identity cannot
    // produce them, so the misconfigured key must fail at load.
    await assert.rejects(
      () => startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP", require_attestation: true }], auditLogPath: join(directory, "audit.jsonl") }),
      (error: unknown) => error instanceof Error && error.message === "Configured signing identity is invalid" && /EC private key/.test(String((error.cause as Error | undefined)?.message)));
    // An organisation-bound key without require_attestation can still serve
    // attested requests, so the same EC rule applies at load.
    await assert.rejects(
      () => startSigningService({ socketPath: join(directory, "sign2.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }], auditLogPath: join(directory, "audit.jsonl") }),
      (error: unknown) => error instanceof Error && error.message === "Configured signing identity is invalid" && /EC private key/.test(String((error.cause as Error | undefined)?.message)));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("signing service rejects query attestations that do not match the bound identity", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-query-reject-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }], auditLogPath: join(directory, "audit.jsonl")});
    try {
      for (const broken of [
        devQueryAttestation({ actor_id: "person-other-owner" }),
        devQueryAttestation({ org_id: "OtherMSP" }),
        devQueryAttestation({ actor_kind: "agent" }),
      ]) {
        const signer = createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => broken });
        await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "rejected");
      }
      assert.ok((await createRemoteSigner({ socketPath: service.socketPath, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => devQueryAttestation() })(Buffer.alloc(32, 14))).byteLength > 0);
    } finally { await service.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("remote signer rejects a receipt attached to an unattested response and reports verified receipts", async t => {
  if (!opensslAvailable()) { t.skip("OpenSSL is required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-stray-receipt-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const privateKey = createPrivateKey(readFileSync(identity.private_key_path));
    // An unattested request answered with a receipt is malformed.
    const stray = await mockSigningSocket(async request => {
      const requestDigest = Buffer.from(String(request.digest), "base64url");
      return { ok: true, signature: sign("sha256", requestDigest, privateKey).toString("base64url"), attestation_signature: sign("sha256", requestDigest, privateKey).toString("base64url") };
    });
    try {
      const signer = createRemoteSigner({ socketPath: stray.path, keyId: "person-sales-owner", certificate: identity.certificate });
      await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "protocol_error");
    } finally { await stray.close(); }
    // A verified receipt is surfaced to the caller with its canonical evidence.
    const receipts: Array<{ receipt: Uint8Array; evidence: Uint8Array }> = [];
    const honest = await mockSigningSocket(async request => {
      const requestDigest = Buffer.from(String(request.digest), "base64url");
      const receipt = evidenceSign(attestationPayload(String(request.key_id), request.attestation as Attestation, requestDigest, Buffer.from(String(request.certificate), "base64url")), privateKey);
      return { ok: true, signature: sign("sha256", requestDigest, privateKey).toString("base64url"), attestation_signature: receipt.toString("base64url") };
    });
    try {
      const attestation = devAttestation();
      const digest = Buffer.alloc(32, 15);
      const signer = createRemoteSigner({ socketPath: honest.path, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => attestation, onAttestationReceipt: (receipt, evidence) => { receipts.push({ receipt, evidence }); } });
      await signer(digest);
      assert.equal(receipts.length, 1);
      assert.deepEqual(receipts[0]?.evidence, attestationPayload("person-sales-owner", attestation, digest, identity.certificate));
      assert.equal(verify("sha256", receipts[0]!.evidence, new X509Certificate(identity.certificate).publicKey, receipts[0]!.receipt), true);
      // A failing receipt callback surfaces through the RemoteSignerError
      // contract — distinguishable from a malformed protocol response, with
      // the caller's error preserved as the cause.
      const hookError = new Error("caller retention failed");
      const throwing = createRemoteSigner({ socketPath: honest.path, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => devAttestation(), onAttestationReceipt: () => { throw hookError; } });
      await assert.rejects(() => throwing(Buffer.alloc(32, 16)), (error: unknown) => error instanceof RemoteSignerError && error.code === "invalid_request" && error.cause === hookError);
      // A hook that returns a promise would reject after the request settles;
      // the signer fails the request deterministically instead.
      const asyncHook = createRemoteSigner({ socketPath: honest.path, keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => devAttestation(), onAttestationReceipt: (() => Promise.resolve()) as unknown as (receipt: Uint8Array, evidence: Uint8Array) => void });
      await assert.rejects(() => asyncHook(Buffer.alloc(32, 17)), (error: unknown) => error instanceof RemoteSignerError && error.code === "invalid_request" && /synchronous/.test(error.message));
    } finally { await honest.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("attestationSlot consumes the context once", () => {
  const context: SigningAttestationContext = {};
  const attestation = devAttestation();
  const slot = attestationSlot(context);
  assert.equal(slot(), undefined);
  context.current = attestation;
  assert.deepEqual(slot(), attestation);
  assert.equal(slot(), undefined);
  assert.equal(context.current, undefined);
});

test("createAttestationSerializer serialises install→consume→clear on one slot", async () => {
  const context: SigningAttestationContext = {};
  const signed = createAttestationSerializer(context);
  const take = attestationSlot(context);
  const decision = devAttestation();
  const query: QueryAttestation = devQueryAttestation();
  let releaseDecision: (() => void) | undefined;
  const decisionGate = new Promise<void>(resolve => { releaseDecision = resolve; });
  // The decision operation holds the slot while its signer is in-flight; the
  // queued query must not start (or install) until it finishes.
  const decisionRun = signed(decision, async () => {
    assert.equal(context.current, decision);
    assert.deepEqual(take(), decision);
    await decisionGate;
    return "decision";
  });
  await Promise.resolve();
  const queryRun = signed(query, async () => {
    assert.equal(context.current, query);
    assert.deepEqual(take(), query);
    return "query";
  });
  await Promise.resolve();
  assert.equal(context.current, undefined, "the consumed slot stays empty until the decision finishes");
  releaseDecision?.();
  assert.equal(await decisionRun, "decision");
  assert.equal(await queryRun, "query");
  assert.equal(context.current, undefined);
});

test("createAttestationSerializer rolls back an unconsumed attestation on failure", async () => {
  const context: SigningAttestationContext = {};
  const signed = createAttestationSerializer(context);
  const decision = devAttestation();
  await assert.rejects(signed(decision, () => Promise.reject(new Error("no signing point reached"))), /no signing point/);
  // The failed operation never consumed its attestation; the slot must not
  // leak it into the next call.
  assert.equal(context.current, undefined);
  const next = await signed(devQueryAttestation(), async () => attestationSlot(context)());
  assert.equal((next as { phase?: string } | undefined)?.phase, "query");
});

test("dedicated read slots sign concurrently with an in-flight decision", async () => {
  const writeContext: SigningAttestationContext = {};
  const queryContext: SigningAttestationContext = {};
  const writeSigned = createAttestationSerializer(writeContext);
  const querySigned = createAttestationSerializer(queryContext);
  const decision = devAttestation();
  const query: QueryAttestation = devQueryAttestation();
  let releaseDecision: (() => void) | undefined;
  const decisionGate = new Promise<void>(resolve => { releaseDecision = resolve; });
  const decisionRun = writeSigned(decision, async () => {
    attestationSlot(writeContext)();
    await decisionGate;
  });
  await Promise.resolve();
  // A separate qscc slot lets read-only signing proceed while the write
  // decision is still in-flight, without touching its context.
  const queryRun = querySigned(query, async () => attestationSlot(queryContext)());
  assert.deepEqual(await queryRun, query);
  assert.equal(queryContext.current, undefined);
  releaseDecision?.();
  await decisionRun;
  assert.equal(writeContext.current, undefined);
});

async function rawSignRequest(path: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let input = Buffer.alloc(0);
    let length: number | undefined;
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("raw signing request timed out")); });
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      if (length === undefined && input.byteLength >= 4) length = input.readUInt32BE(0);
      if (length === undefined || input.byteLength < length + 4) return;
      socket.destroy();
      resolve(JSON.parse(input.subarray(4, length + 4).toString("utf8")) as Record<string, unknown>);
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("signing service closed without a response")));
    socket.on("connect", () => socket.write(frame(request)));
  });
}

test("signing service rejects malformed attestations as invalid requests", async t => {
  if (!sdkAvailable || !opensslAvailable()) { t.skip("Fabric SDK and OpenSSL are required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "knowledger-signing-attestation-invalid-"));
  try {
    const identity = generateAttestedIdentity(directory, { "kcl.actor_id": "person-sales-owner", "kcl.actor_kind": "human" });
    const service = await startSigningService({ socketPath: join(directory, "sign.sock"), keys: [{ key_id: "person-sales-owner", certificate_path: identity.certificate_path, private_key_path: identity.private_key_path, org_id: "SalesMSP" }], auditLogPath: join(directory, "audit.jsonl")});
    let neverDir: string | undefined;
    try {
      const request = (attestation: unknown) => ({ operation: "sign", key_id: "person-sales-owner", digest: Buffer.alloc(32).toString("base64url"), certificate: identity.certificate.toString("base64url"), attestation });
      const { tx_id: _txId, ...withoutTx } = devAttestation();
      const { phase: _phase, ...withoutPhase } = withoutTx;
      for (const attestation of [
        { ...devAttestation(), command_digest: "bad" },
        { ...devAttestation(), extra: "field" },
        // A decision attestation without the transaction binding must be
        // refused on its own, not only when phase is also absent.
        withoutTx,
        withoutPhase,
        "not-an-object",
      ]) {
        assert.deepEqual(await rawSignRequest(service.socketPath, request(attestation)), { ok: false, error: "invalid_request" });
      }
      // The client applies the same shape check before any socket round-trip:
      // a decision attestation without tx_id fails locally as invalid_request.
      // The socket is never connected; a per-test path keeps the name unique.
      neverDir = mkdtempSync(join(tmpdir(), "kcl-nv-"));
      const { tx_id: _droppedTx, ...clientWithoutTx } = devAttestation();
      const signer = createRemoteSigner({ socketPath: join(neverDir, "s.sock"), keyId: "person-sales-owner", certificate: identity.certificate, attestation: () => clientWithoutTx as Attestation });
      await assert.rejects(() => signer(Buffer.alloc(32)), (error: unknown) => error instanceof RemoteSignerError && error.code === "invalid_request" && /missing or unknown fields/.test(error.message));
    } finally { await service.close(); if (neverDir !== undefined) fs.rmSync(neverDir, { recursive: true, force: true }); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
