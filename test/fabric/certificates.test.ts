import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { applyRenewal, CertificateMaintenanceError, checkCertificates, prepareRenewal } from '../../infra/fabric/certificates.ts';
import { DEVELOPMENT_ORGANIZATIONS } from '../../examples/order-workflow/organizations.ts';

const requireFabric = createRequire(new URL('../../packages/fabric/package.json', import.meta.url));
let dependencies = spawnSync('openssl', ['version']).status === 0;
for (const dependency of ['@hyperledger/fabric-protos', '@fidm/x509']) {
  try { requireFabric.resolve(dependency); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    dependencies = false;
  }
}
const options = { skip: !dependencies };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function write(path: string, bytes: string | Uint8Array): void {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, bytes, { mode: 0o600 });
}
function openssl(args: string[]): void {
  assert.equal(spawnSync('openssl', args, { stdio: 'ignore', timeout: 15_000 }).status, 0, 'synthetic certificate issuance succeeds');
}
function key(path: string): void {
  write(path, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
}
function fixture(t: TestContext, caDays = 365) {
  const root = fs.mkdtempSync('/tmp/kcl-cert-test-');
  t.after(() => fs.rmSync(root, { recursive: true }));
  const { common, msp } = requireFabric('@hyperledger/fabric-protos');
  const application = new common.ConfigGroup();
  const profiles = DEVELOPMENT_ORGANIZATIONS.map(org => {
    const domain = `${org.domain}.kcl.test`;
    const base = join(root, 'crypto/peerOrganizations', domain);
    const ca = join(base, 'ca', `ca.${domain}-cert.pem`);
    const caKey = join(base, 'ca/ca_sk');
    const anchor = join(base, 'msp/cacerts', `ca.${domain}-cert.pem`);
    const user = join(base, 'users', `User1@${domain}`, 'msp');
    const privateKey = join(user, 'keystore/user_sk');
    const cert = join(user, 'signcerts', `User1@${domain}-cert.pem`);
    key(caKey); key(privateKey);
    openssl(['req', '-new', '-x509', '-key', caKey, '-subj', `/C=US/O=${domain}/CN=ca.${domain}`, '-days', String(caDays), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', ca]);
    write(anchor, fs.readFileSync(ca));
    const csr = join(root, `${org.domain}.csr`);
    const ext = join(root, `${org.domain}.ext`);
    const attrs = JSON.stringify({ attrs: { 'kcl.actor_id': org.key_id, 'kcl.actor_kind': 'human' } });
    write(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n1.2.3.4.5.6.7.8.1=DER:${Buffer.from(attrs).toString('hex').match(/../g)!.join(':')}\n`);
    openssl(['req', '-new', '-key', privateKey, '-subj', `/C=US/O=${domain}/OU=client/CN=User1@${domain}`, '-out', csr]);
    fs.mkdirSync(dirname(cert), { recursive: true });
    openssl(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-set_serial', '0x12345678', '-days', '7', '-extfile', ext, '-out', cert]);
    const fabricMsp = new msp.FabricMSPConfig();
    fabricMsp.setName(org.org_id); fabricMsp.setRootCertsList([fs.readFileSync(ca)]);
    const outer = new msp.MSPConfig(); outer.setType(0); outer.setConfig(fabricMsp.serializeBinary());
    const value = new common.ConfigValue(); value.setValue(outer.serializeBinary());
    const group = new common.ConfigGroup(); group.getValuesMap().set('MSP', value);
    application.getGroupsMap().set(org.org_id, group);
    return { ...org, cert, privateKey, caKey, ca, anchor };
  });
  const channelGroup = new common.ConfigGroup(); channelGroup.getGroupsMap().set('Application', application);
  const config = new common.Config(); config.setChannelGroup(channelGroup);
  const configEnvelope = new common.ConfigEnvelope(); configEnvelope.setConfig(config);
  const channelHeader = new common.ChannelHeader(); channelHeader.setType(common.HeaderType.CONFIG); channelHeader.setChannelId('kcl-demo');
  const header = new common.Header(); header.setChannelHeader(channelHeader.serializeBinary());
  const payload = new common.Payload(); payload.setHeader(header); payload.setData(configEnvelope.serializeBinary());
  const envelope = new common.Envelope(); envelope.setPayload(payload.serializeBinary());
  const data = new common.BlockData(); data.setDataList([envelope.serializeBinary()]);
  const blockHeader = new common.BlockHeader(); blockHeader.setNumber(0); blockHeader.setDataHash(createHash('sha256').update(envelope.serializeBinary()).digest());
  const block = new common.Block(); block.setHeader(blockHeader); block.setData(data);
  write(join(root, 'channel.block'), block.serializeBinary());
  return { root, profiles };
}

function prepared(root: string) {
  const result = prepareRenewal(root);
  assert.equal(result.status, 'prepared'); assert.ok(result.plan_path);
  const path = join(root, result.plan_path);
  return { path, plan: JSON.parse(fs.readFileSync(path, 'utf8')) };
}
function snapshot(paths: string[]): string[] { return paths.map(path => digest(fs.readFileSync(path))); }
function rejectsSafely(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof CertificateMaintenanceError && !error.message.includes('PRIVATE KEY'));
}

test('certificate check reads public files without opening keys', options, t => {
  const { root } = fixture(t);
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path: any, ...args: any[]) => {
    assert.ok(!String(path).endsWith('_sk'), 'check must not read a private key');
    return (original as any)(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const inventory = checkCertificates(root);
  assert.equal(inventory.status, 'expiring');
  assert.equal(inventory.certificates.filter(cert => cert.status === 'expiring').length, 3);
});

test('renewal preserves keys, genesis, subject and raw Fabric attributes; apply is idempotent', options, t => {
  const { root, profiles } = fixture(t);
  const protectedPaths = [join(root, 'channel.block'), ...profiles.flatMap(p => [p.privateKey, p.caKey, p.ca, p.anchor])];
  const unchanged = snapshot(protectedPaths);
  const before = profiles.map(p => fs.readFileSync(p.cert));
  const { path, plan } = prepared(root);
  assert.deepEqual(profiles.map(p => fs.readFileSync(p.cert)), before, 'prepare does not replace active certificates');
  for (const [index, entry] of plan.certificates.entries()) {
    const old = new X509Certificate(before[index]);
    const bytes = fs.readFileSync(join(root, entry.new_cert_path));
    const renewed = new X509Certificate(bytes);
    assert.equal(renewed.subject, old.subject); assert.equal(renewed.issuer, old.issuer);
    assert.deepEqual(renewed.publicKey.export({ type: 'spki', format: 'der' }), old.publicKey.export({ type: 'spki', format: 'der' }));
    assert.ok(Date.parse(renewed.validTo) > Date.parse(old.validTo) + 80 * 86_400_000);
    const { Certificate } = requireFabric('@fidm/x509');
    const attrs = JSON.parse(Certificate.fromPEM(bytes).getExtension('1.2.3.4.5.6.7.8.1').value.toString());
    assert.deepEqual(attrs, { attrs: { 'kcl.actor_id': profiles[index].key_id, 'kcl.actor_kind': 'human' } });
  }
  for (const file of fs.readdirSync(dirname(path))) {
    assert.ok(!fs.readFileSync(join(dirname(path), file), 'utf8').includes('PRIVATE KEY'), 'staged artifacts contain no private keys');
  }
  assert.equal(applyRenewal(root, path).changed, 3);
  const repeated = applyRenewal(root, path);
  assert.equal(repeated.changed, 0);
  assert.equal(repeated.restart_required, true, 'maintenance cannot attest external process reloads');
  assert.equal(checkCertificates(root).status, 'ok');
  assert.equal(prepareRenewal(root).status, 'current');
  assert.deepEqual(snapshot(protectedPaths), unchanged);
});

test('apply preflights every candidate and rejects tampering without partial replacements', options, t => {
  const { root, profiles } = fixture(t);
  const before = snapshot(profiles.map(p => p.cert));
  const { path, plan } = prepared(root);
  fs.appendFileSync(join(root, plan.certificates[2].new_cert_path), '\nchanged');
  rejectsSafely(() => applyRenewal(root, path));
  assert.deepEqual(snapshot(profiles.map(p => p.cert)), before);
});

test('renewal rejects key mismatch, certified actor drift, CA drift, invalid days and unsafe symlinks', options, t => {
  const { root, profiles } = fixture(t);
  rejectsSafely(() => prepareRenewal(root, { days: 14 }));
  rejectsSafely(() => prepareRenewal(root, { days: 366 }));
  const userKey = fs.readFileSync(profiles[0].privateKey);
  key(profiles[0].privateKey);
  rejectsSafely(() => prepareRenewal(root));
  fs.writeFileSync(profiles[0].privateKey, userKey);
  const originalCert = fs.readFileSync(profiles[0].cert);
  const ext = join(root, 'sales.ext');
  const wrongAttrs = Buffer.from(JSON.stringify({ attrs: { 'kcl.actor_id': 'person-wrong-owner', 'kcl.actor_kind': 'human' } })).toString('hex');
  fs.writeFileSync(ext, fs.readFileSync(ext, 'utf8').replace(/^1\.2\.3\.4\.5\.6\.7\.8\.1=.*$/m, `1.2.3.4.5.6.7.8.1=DER:${wrongAttrs}`));
  openssl(['x509', '-req', '-in', join(root, 'sales.csr'), '-CA', profiles[0].ca, '-CAkey', profiles[0].caKey, '-set_serial', '0xabcdef', '-days', '7', '-extfile', ext, '-out', profiles[0].cert]);
  rejectsSafely(() => prepareRenewal(root));
  fs.writeFileSync(profiles[0].cert, originalCert);
  fs.writeFileSync(profiles[0].anchor, fs.readFileSync(profiles[1].ca));
  rejectsSafely(() => prepareRenewal(root));
  fs.writeFileSync(profiles[0].anchor, fs.readFileSync(profiles[0].ca));
  const { path, plan } = prepared(root);
  const candidate = join(root, plan.certificates[0].new_cert_path);
  fs.unlinkSync(candidate); fs.symlinkSync(profiles[0].cert, candidate);
  rejectsSafely(() => applyRenewal(root, path));
});

test('renewal refuses a candidate that would outlive the issuing CA', options, t => {
  const { root } = fixture(t, 30);
  rejectsSafely(() => prepareRenewal(root));
});

test('apply rolls back an interrupted replacement and a retry finishes safely', options, t => {
  const { root, profiles } = fixture(t);
  const before = snapshot(profiles.map(p => p.cert));
  const { path } = prepared(root);
  const original = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    if (!failed && String(target) === profiles[1].cert) { failed = true; throw new Error('synthetic disk failure'); }
    return original(source, target);
  });
  syncBuiltinESMExports();
  try {
    rejectsSafely(() => applyRenewal(root, path));
    assert.equal(failed, true);
    assert.deepEqual(snapshot(profiles.map(p => p.cert)), before);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(applyRenewal(root, path).changed, 3);
});

test('renewal can recover after the old enrollment certificates expire', options, t => {
  const { root, profiles } = fixture(t);
  const old = new X509Certificate(fs.readFileSync(profiles[0].cert));
  const future = Date.parse(old.validTo) + 1000;
  t.mock.method(Date, 'now', () => future);
  try {
    assert.equal(checkCertificates(root).status, 'expired');
    const { path } = prepared(root);
    assert.equal(applyRenewal(root, path).changed, 3);
    assert.equal(checkCertificates(root).status, 'ok');
  } finally { t.mock.restoreAll(); }
});

test('apply rejects genesis drift and stale candidates, then resumes a partially installed plan', options, t => {
  const { root, profiles } = fixture(t);
  const { path, plan } = prepared(root);
  const genesisPath = join(root, 'channel.block');
  const genesis = fs.readFileSync(genesisPath);
  fs.appendFileSync(genesisPath, Buffer.from([0x78, 0x01]));
  rejectsSafely(() => applyRenewal(root, path));
  fs.writeFileSync(genesisPath, genesis);
  t.mock.method(Date, 'now', () => Date.parse(plan.certificates[0].new_valid_to) - 86_400_000);
  try { rejectsSafely(() => applyRenewal(root, path)); }
  finally { t.mock.restoreAll(); }
  fs.writeFileSync(profiles[0].cert, fs.readFileSync(join(root, plan.certificates[0].new_cert_path)));
  assert.equal(applyRenewal(root, path).changed, 2, 'interrupted batch resumes without replacing the already renewed cert');
});

test('apply rolls back even when directory fsync fails after the replacement rename', options, t => {
  const { root, profiles } = fixture(t);
  const { path } = prepared(root);
  const before = snapshot(profiles.map(p => p.cert));
  const rename = fs.renameSync;
  const fsync = fs.fsyncSync;
  let failSync = false;
  let injected = false;
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
    rename(source, target);
    if (!injected && String(target) === profiles[0].cert) failSync = true;
  });
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (failSync) { failSync = false; injected = true; throw new Error('synthetic directory sync failure'); }
    return fsync(fd);
  });
  syncBuiltinESMExports();
  try {
    rejectsSafely(() => applyRenewal(root, path));
    assert.equal(injected, true);
    assert.deepEqual(snapshot(profiles.map(p => p.cert)), before);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
