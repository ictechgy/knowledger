/** Safe, narrowly-scoped maintenance for the disposable development enrollments. */
import { spawnSync } from 'node:child_process';
import {
  X509Certificate,
  createHash,
  createPrivateKey,
  randomBytes,
} from 'node:crypto';
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEVELOPMENT_ORGANIZATIONS } from '../../examples/order-workflow/organizations.ts';
import { parseStrictJson } from '../../packages/fabric/canonical.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 90;
const DEFAULT_WARN_DAYS = 14;
const MAX_DAYS = 365;
const MAX_CERT_BYTES = 64 * 1024;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_BLOCK_BYTES = 32 * 1024 * 1024;
const OPENSSL_TIMEOUT_MS = 15_000;
const FABRIC_ATTRIBUTES_OID = '1.2.3.4.5.6.7.8.1';
const PLAN_SCHEMA = 'kcl.test-certificate-renewal';
const ALLOWED_LEAF_EXTENSIONS = new Set([
  '2.5.29.14', // subjectKeyIdentifier
  '2.5.29.15', // keyUsage
  '2.5.29.19', // basicConstraints
  '2.5.29.35', // authorityKeyIdentifier
  FABRIC_ATTRIBUTES_OID,
]);

type CertificateStatus = 'ok' | 'expiring' | 'expired';

export interface CertificateMetadata {
  path: string;
  profile?: string;
  subject: string;
  issuer: string;
  serial_number: string;
  valid_from: string;
  valid_to: string;
  days_remaining: number;
  status: CertificateStatus;
}

export interface CertificateCheckResult {
  status: CertificateStatus;
  checked_at: string;
  warn_days: number;
  certificates: CertificateMetadata[];
}

export interface PrepareRenewalOptions {
  days?: number;
  renewBeforeDays?: number;
}

export interface PrepareRenewalResult {
  status: 'prepared' | 'current';
  checked_at: string;
  days: number;
  renew_before_days: number;
  certificates: CertificateMetadata[];
  plan_path?: string;
  prepared_at?: string;
  channel_block_sha256?: string;
}

export interface ApplyRenewalResult {
  status: 'applied';
  changed: number;
  restart_required: boolean;
  plan_path: string;
}

export class CertificateMaintenanceError extends Error {
  readonly code: string;

  constructor(code: string, message = 'Test certificate maintenance failed') {
    super(message);
    this.name = 'CertificateMaintenanceError';
    this.code = code;
  }
}

interface ProfilePaths {
  org_id: string;
  actor_id: string;
  domain: string;
  user: string;
  cert: string;
  keystore: string;
  ca_cert: string;
  ca_msp_cert: string;
  ca_keystore: string;
}

interface PublicProfile {
  paths: ProfilePaths;
  certificate_bytes: Buffer;
  certificate: X509Certificate;
  ca_bytes: Buffer;
  ca_certificate: X509Certificate;
}

interface RenewalPlanCertificate {
  org_id: string;
  domain: string;
  target_path: string;
  old_cert_path: string;
  csr_path: string;
  new_cert_path: string;
  old_sha256: string;
  new_sha256: string;
  ca_sha256: string;
  old_valid_to: string;
  new_valid_to: string;
}

interface RenewalPlan {
  schema: typeof PLAN_SCHEMA;
  version: 1;
  status: 'prepared' | 'applied';
  created_at: string;
  applied_at?: string;
  days: number;
  renew_before_days: number;
  channel_block_sha256: string;
  certificates: RenewalPlanCertificate[];
}

function fail(code: string, message?: string): never {
  throw new CertificateMaintenanceError(code, message);
}

function validateInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_ARGUMENT', `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizedOptions(options: PrepareRenewalOptions = {}) {
  const days = validateInteger(options.days ?? DEFAULT_DAYS, 'days', 1, MAX_DAYS);
  const renewBeforeDays = validateInteger(options.renewBeforeDays ?? DEFAULT_WARN_DAYS, 'renewBeforeDays', 0, MAX_DAYS - 1);
  if (days <= renewBeforeDays) fail('INVALID_ARGUMENT', 'days must be greater than renewBeforeDays');
  return { days, renewBeforeDays };
}

function stateRoot(stateDir: string): string {
  if (typeof stateDir !== 'string' || stateDir.length === 0 || stateDir.includes('\0')) fail('INVALID_ARGUMENT', 'Invalid state directory');
  const root = resolve(stateDir);
  let stat;
  try { stat = lstatSync(root); } catch { fail('INVALID_STATE', 'Test network state directory is unavailable'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_STATE', 'Test network state directory is invalid');
  return root;
}

function relativePath(root: string, path: string): string {
  const value = relative(root, path);
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) fail('PATH_ESCAPE', 'Certificate path is outside the test network state');
  return value.split(sep).join('/');
}

function assertConfined(root: string, path: string): void {
  const confined = relativePath(root, path);
  const parts = confined.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    let stat;
    try { stat = lstatSync(parent); } catch { fail('INVALID_STATE', 'Certificate material parent is unavailable'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_FILE', 'Certificate material parent is unsafe');
  }
}

function assertRegularFile(root: string, path: string, options: { private?: boolean; maxBytes?: number } = {}): Stats {
  assertConfined(root, path);
  let stat;
  try { stat = lstatSync(path); } catch { fail('INVALID_STATE', 'Required certificate material is unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_FILE', 'Certificate material must be a regular unlinked file');
  if (options.private && (stat.mode & 0o077) !== 0) fail('UNSAFE_FILE', 'Private certificate material has unsafe permissions');
  if (options.maxBytes !== undefined && stat.size > options.maxBytes) fail('FILE_TOO_LARGE', 'Certificate material exceeds its size limit');
  return stat;
}

function readBounded(root: string, path: string, maxBytes: number, options: { private?: boolean } = {}): Buffer {
  assertRegularFile(root, path, { private: options.private, maxBytes });
  return readFileSync(path);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseCertificate(bytes: Buffer): X509Certificate {
  try { return new X509Certificate(bytes); } catch { return fail('INVALID_CERTIFICATE', 'Invalid certificate in test network state'); }
}

function statusFor(certificate: X509Certificate, warnDays: number, now = Date.now()): CertificateStatus {
  const from = Date.parse(certificate.validFrom);
  const to = Date.parse(certificate.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > now || to <= now) return 'expired';
  return to - now <= warnDays * DAY_MS ? 'expiring' : 'ok';
}

function metadata(root: string, path: string, certificate: X509Certificate, warnDays: number, profile?: string): CertificateMetadata {
  const remaining = Date.parse(certificate.validTo) - Date.now();
  return {
    path: relativePath(root, path),
    ...(profile ? { profile } : {}),
    subject: certificate.subject,
    issuer: certificate.issuer,
    serial_number: certificate.serialNumber,
    valid_from: new Date(certificate.validFrom).toISOString(),
    valid_to: new Date(certificate.validTo).toISOString(),
    days_remaining: Math.max(0, Math.floor(remaining / DAY_MS)),
    status: statusFor(certificate, warnDays),
  };
}

function profilePaths(root: string): ProfilePaths[] {
  return DEVELOPMENT_ORGANIZATIONS.map(profile => {
    const domain = `${profile.domain}.kcl.test`;
    const organization = join(root, 'crypto', 'peerOrganizations', domain);
    const user = `User1@${domain}`;
    return {
      org_id: profile.org_id,
      actor_id: profile.key_id,
      domain,
      user,
      cert: join(organization, 'users', user, 'msp', 'signcerts', `${user}-cert.pem`),
      keystore: join(organization, 'users', user, 'msp', 'keystore'),
      ca_cert: join(organization, 'ca', `ca.${domain}-cert.pem`),
      ca_msp_cert: join(organization, 'msp', 'cacerts', `ca.${domain}-cert.pem`),
      ca_keystore: join(organization, 'ca'),
    };
  });
}

function knownCertificateName(name: string): boolean {
  return name.endsWith('-cert.pem') || name === 'ca.crt' || name === 'server.crt' || name === 'client.crt';
}

function collectPublicCertificates(root: string): string[] {
  const cryptoRoot = join(root, 'crypto');
  let rootStat;
  try { rootStat = lstatSync(cryptoRoot); } catch { fail('INVALID_STATE', 'Test network crypto directory is unavailable'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('INVALID_STATE', 'Test network crypto directory is invalid');
  const found: string[] = [];
  const pending = [{ path: cryptoRoot, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > 20 || ++visited > 10_000) fail('INVALID_STATE', 'Test network certificate tree is too large');
    let entries;
    try { entries = readdirSync(current.path, { withFileTypes: true }); } catch { fail('INVALID_STATE', 'Test network certificate tree cannot be read'); }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isSymbolicLink()) {
        if (knownCertificateName(entry.name)) fail('UNSAFE_FILE', 'Public certificate must not be a symbolic link');
        continue;
      }
      if (entry.isDirectory()) pending.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && knownCertificateName(entry.name)) found.push(path);
    }
  }
  found.sort();
  return found;
}

function aggregateStatus(values: CertificateMetadata[]): CertificateStatus {
  if (values.some(value => value.status === 'expired')) return 'expired';
  if (values.some(value => value.status === 'expiring')) return 'expiring';
  return 'ok';
}

export function checkCertificates(stateDir: string, warnDays = DEFAULT_WARN_DAYS): CertificateCheckResult {
  const root = stateRoot(stateDir);
  validateInteger(warnDays, 'warnDays', 0, MAX_DAYS);
  const expected = new Map(profilePaths(root).map(profile => [profile.cert, profile.org_id]));
  const found = collectPublicCertificates(root);
  for (const required of expected.keys()) if (!found.includes(required)) fail('MISSING_ENROLLMENT', 'Expected development enrollment certificate is unavailable');
  const certificates = found.map(path => {
    const bytes = readBounded(root, path, MAX_CERT_BYTES);
    return metadata(root, path, parseCertificate(bytes), warnDays, expected.get(path));
  });
  if (certificates.filter(certificate => certificate.profile !== undefined).length !== DEVELOPMENT_ORGANIZATIONS.length) {
    fail('MISSING_ENROLLMENT', 'Expected three development enrollment certificates');
  }
  return { status: aggregateStatus(certificates), checked_at: new Date().toISOString(), warn_days: warnDays, certificates };
}

function loadDependencies(): { Certificate: any; common: any; msp: any } {
  try {
    const requireFabric = createRequire(new URL('../../packages/fabric/package.json', import.meta.url));
    const { Certificate } = requireFabric('@fidm/x509');
    const { common, msp } = requireFabric('@hyperledger/fabric-protos');
    return { Certificate, common, msp };
  } catch { return fail('DEPENDENCY_UNAVAILABLE', 'Certificate maintenance dependencies are unavailable'); }
}

function exactObject(value: unknown, expected: Record<string, string>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const wanted = Object.keys(expected).sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index] && record[key] === expected[key]);
}

function validateLeafCertificate(
  bytes: Buffer,
  caBytes: Buffer,
  paths: ProfilePaths,
  options: { allowExpired?: boolean } = {},
  now = Date.now(),
): X509Certificate {
  const leaf = parseCertificate(bytes);
  const ca = parseCertificate(caBytes);
  if (Date.parse(leaf.validFrom) > now || (!options.allowExpired && Date.parse(leaf.validTo) <= now)) fail('INVALID_CERTIFICATE', 'Development enrollment certificate is outside its validity period');
  if (Date.parse(ca.validFrom) > now || Date.parse(ca.validTo) <= now || !ca.ca || ca.subject !== ca.issuer || !ca.verify(ca.publicKey)) {
    fail('INVALID_CA', 'Development organization CA is invalid');
  }
  if (Date.parse(leaf.validTo) > Date.parse(ca.validTo) || leaf.ca || leaf.issuer !== ca.subject || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) fail('INVALID_CERTIFICATE', 'Development enrollment certificate is not issued by its configured CA');

  const { Certificate } = loadDependencies();
  let parsed: any;
  let parsedCa: any;
  try {
    parsed = Certificate.fromPEM(bytes);
    parsedCa = Certificate.fromPEM(caBytes);
  } catch { fail('INVALID_CERTIFICATE', 'Development enrollment certificate cannot be decoded'); }
  if (parsedCa.getExtension('keyUsage', 'keyCertSign') !== true) fail('INVALID_CA', 'Development organization CA cannot issue certificates');
  const subject = parsed.subject;
  const expectedSubjectOids = ['2.5.4.6', '2.5.4.10', '2.5.4.11', '2.5.4.3'].sort();
  const actualSubjectOids = subject.attributes.map((attribute: any) => attribute.oid).sort();
  if (actualSubjectOids.length !== expectedSubjectOids.length || actualSubjectOids.some((oid: string, index: number) => oid !== expectedSubjectOids[index])
    || subject.countryName !== 'US' || subject.organizationName !== paths.domain || subject.organizationalUnitName !== 'client' || subject.commonName !== paths.user) {
    fail('INVALID_CERTIFICATE', 'Development enrollment certificate subject does not match its profile');
  }
  const extensionOids = parsed.extensions.map((extension: any) => extension.oid);
  if (extensionOids.length !== ALLOWED_LEAF_EXTENSIONS.size || new Set(extensionOids).size !== extensionOids.length
    || extensionOids.some((oid: string) => !ALLOWED_LEAF_EXTENSIONS.has(oid))) {
    fail('INVALID_CERTIFICATE', 'Development enrollment certificate has unexpected extensions');
  }
  const constraints = parsed.getExtension('basicConstraints');
  const keyUsage = parsed.getExtension('keyUsage');
  if (!constraints || constraints.critical !== true || parsed.isCA || constraints.isCA !== false
    || !keyUsage || keyUsage.critical !== true || keyUsage.digitalSignature !== true
    || ['nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'].some(flag => keyUsage[flag] === true)
    || parsed.getExtension('subjectKeyIdentifier') === null || parsed.getExtension('authorityKeyIdentifier') === null
    || !parsed.verifySubjectKeyIdentifier() || !parsed.authorityKeyIdentifier
    || !parsedCa.subjectKeyIdentifier || parsed.authorityKeyIdentifier !== parsedCa.subjectKeyIdentifier) {
    fail('INVALID_CERTIFICATE', 'Development enrollment certificate usage is invalid');
  }
  const attributeExtension = parsed.getExtension(FABRIC_ATTRIBUTES_OID);
  let attributes: unknown;
  try {
    attributes = parseStrictJson(attributeExtension.value);
  } catch { fail('INVALID_CERTIFICATE', 'Development enrollment attributes are invalid'); }
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)
    || Object.keys(attributes as Record<string, unknown>).length !== 1
    || !exactObject((attributes as Record<string, unknown>).attrs, { 'kcl.actor_id': paths.actor_id, 'kcl.actor_kind': 'human' })) {
    fail('INVALID_CERTIFICATE', 'Development enrollment attributes do not match its profile');
  }
  return leaf;
}

function extractApplicationRoots(blockBytes: Buffer): Map<string, Buffer[]> {
  const { common, msp } = loadDependencies();
  try {
    const block = common.Block.deserializeBinary(blockBytes);
    const envelopes = block.getData()?.getDataList_asU8?.() ?? [];
    if (envelopes.length !== 1) fail('INVALID_GENESIS', 'Channel genesis block has an unexpected envelope count');
    const envelope = common.Envelope.deserializeBinary(envelopes[0]);
    const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
    const configEnvelope = common.ConfigEnvelope.deserializeBinary(payload.getData_asU8());
    const application = configEnvelope.getConfig()?.getChannelGroup()?.getGroupsMap()?.get('Application');
    if (!application) fail('INVALID_GENESIS', 'Channel genesis block has no Application group');
    const roots = new Map<string, Buffer[]>();
    for (const [orgId, group] of application.getGroupsMap().entries()) {
      const value = group.getValuesMap().get('MSP');
      if (!value) continue;
      const outer = msp.MSPConfig.deserializeBinary(value.getValue_asU8());
      const fabric = msp.FabricMSPConfig.deserializeBinary(outer.getConfig_asU8());
      if (fabric.getName() !== orgId) fail('INVALID_GENESIS', 'Channel genesis MSP identity is inconsistent');
      roots.set(orgId, fabric.getRootCertsList_asU8().map((bytes: Uint8Array) => Buffer.from(bytes)));
    }
    return roots;
  } catch (error) {
    if (error instanceof CertificateMaintenanceError) throw error;
    return fail('INVALID_GENESIS', 'Channel genesis block cannot be decoded');
  }
}

function loadPublicProfiles(root: string): { profiles: PublicProfile[]; channelBytes: Buffer; channelHash: string } {
  const channelPath = join(root, 'channel.block');
  const channelBytes = readBounded(root, channelPath, MAX_BLOCK_BYTES);
  const channelRoots = extractApplicationRoots(channelBytes);
  const profiles = profilePaths(root).map(paths => {
    const certificateBytes = readBounded(root, paths.cert, MAX_CERT_BYTES);
    const caBytes = readBounded(root, paths.ca_cert, MAX_CERT_BYTES);
    const caMspBytes = readBounded(root, paths.ca_msp_cert, MAX_CERT_BYTES);
    if (!caBytes.equals(caMspBytes)) fail('CA_DRIFT', 'Development organization CA copies do not match');
    const roots = channelRoots.get(paths.org_id);
    if (!roots || roots.length === 0 || !roots.some(rootBytes => rootBytes.equals(caBytes))) fail('CA_DRIFT', 'Development organization CA does not match channel genesis');
    const certificate = validateLeafCertificate(certificateBytes, caBytes, paths, { allowExpired: true });
    return { paths, certificate_bytes: certificateBytes, certificate, ca_bytes: caBytes, ca_certificate: parseCertificate(caBytes) };
  });
  if (channelRoots.size < profiles.length) fail('INVALID_GENESIS', 'Channel genesis is missing a development organization');
  return { profiles, channelBytes, channelHash: sha256(channelBytes) };
}

function singlePrivateKey(root: string, directory: string): string {
  assertConfined(root, directory);
  let stat;
  try { stat = lstatSync(directory); } catch { fail('INVALID_STATE', 'Signing key directory is unavailable'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_FILE', 'Signing key directory is invalid');
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { fail('INVALID_STATE', 'Signing key directory cannot be read'); }
  const candidates = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() && (entry.name.endsWith('_sk') || entry.name === 'priv_sk'));
  if (candidates.length !== 1) fail('INVALID_STATE', 'Expected exactly one signing key');
  const path = join(directory, candidates[0].name);
  assertRegularFile(root, path, { private: true, maxBytes: MAX_CERT_BYTES });
  return path;
}

function readPrivateKey(root: string, path: string) {
  try { return createPrivateKey(readBounded(root, path, MAX_CERT_BYTES, { private: true })); }
  catch (error) {
    if (error instanceof CertificateMaintenanceError) throw error;
    return fail('INVALID_KEY', 'Development signing key is invalid');
  }
}

function validateKeyMatches(root: string, keyPath: string, certificate: X509Certificate): void {
  const key = readPrivateKey(root, keyPath);
  if (!certificate.checkPrivateKey(key)) fail('KEY_MISMATCH', 'Development signing key does not match its certificate');
}

function runOpenSsl(args: string[]): void {
  const result = spawnSync('openssl', args, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: OPENSSL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal) fail('OPENSSL_FAILED', 'OpenSSL certificate operation failed');
}

function secureDirectory(root: string, path: string): void {
  assertConfined(root, path);
  mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('UNSAFE_FILE', 'Renewal directory permissions are unsafe');
}

function secureWrite(path: string, bytes: string | Uint8Array): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function atomicWrite(path: string, bytes: string | Uint8Array): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    secureWrite(temp, bytes);
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } finally {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* the caller reports the primary failure */ }
  }
}

function extensionConfiguration(paths: ProfilePaths): string {
  const attributes = JSON.stringify({ attrs: { 'kcl.actor_id': paths.actor_id, 'kcl.actor_kind': 'human' } });
  return [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid:always',
    `${FABRIC_ATTRIBUTES_OID}=DER:${Buffer.from(attributes, 'utf8').toString('hex')}`,
    '',
  ].join('\n');
}

function stageName(paths: ProfilePaths, suffix: string): string {
  return `${paths.org_id}-${suffix}`;
}

function writePlan(path: string, plan: RenewalPlan, create: boolean): void {
  const bytes = `${JSON.stringify(plan, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_PLAN_BYTES) fail('INVALID_PLAN', 'Renewal plan exceeds its size limit');
  if (create) secureWrite(path, bytes);
  else atomicWrite(path, bytes);
}

export function prepareRenewal(stateDir: string, options: PrepareRenewalOptions = {}): PrepareRenewalResult {
  const root = stateRoot(stateDir);
  const { days, renewBeforeDays } = normalizedOptions(options);
  const publicState = loadPublicProfiles(root);
  const checkedAt = new Date().toISOString();
  const publicInventory = checkCertificates(root, renewBeforeDays).certificates;
  const needsRenewal = publicState.profiles.some(profile => Date.parse(profile.certificate.validTo) - Date.now() <= renewBeforeDays * DAY_MS);
  if (!needsRenewal) return { status: 'current', checked_at: checkedAt, days, renew_before_days: renewBeforeDays, certificates: publicInventory };

  const renewalRoot = join(root, 'certificate-renewals');
  if (!existsSync(renewalRoot)) secureDirectory(root, renewalRoot);
  else {
    const stat = lstatSync(renewalRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('UNSAFE_FILE', 'Renewal directory permissions are unsafe');
  }
  const createdAt = new Date().toISOString();
  const stage = join(renewalRoot, `renewal-${createdAt.replaceAll(/[^0-9]/g, '').slice(0, 14)}-${randomBytes(8).toString('hex')}`);
  secureDirectory(root, stage);
  const certificates: RenewalPlanCertificate[] = [];
  for (const profile of publicState.profiles) {
    const { paths } = profile;
    const userKey = singlePrivateKey(root, paths.keystore);
    const caKey = singlePrivateKey(root, paths.ca_keystore);
    validateKeyMatches(root, userKey, profile.certificate);
    validateKeyMatches(root, caKey, profile.ca_certificate);

    const oldPath = join(stage, stageName(paths, 'old-cert.pem'));
    const csrPath = join(stage, stageName(paths, 'request.csr'));
    const newPath = join(stage, stageName(paths, 'new-cert.pem'));
    const extensionPath = join(stage, stageName(paths, 'extensions.cnf'));
    secureWrite(oldPath, profile.certificate_bytes);
    try {
      secureWrite(extensionPath, extensionConfiguration(paths));
      runOpenSsl(['x509', '-x509toreq', '-in', oldPath, '-signkey', userKey, '-out', csrPath]);
      runOpenSsl([
        'x509', '-req', '-in', csrPath, '-CA', paths.ca_cert, '-CAkey', caKey,
        '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', String(days), '-sha256',
        '-extfile', extensionPath, '-out', newPath,
      ]);
      chmodSync(csrPath, 0o600);
      chmodSync(newPath, 0o600);
    } finally {
      try { if (existsSync(extensionPath)) unlinkSync(extensionPath); } catch { /* a failed stage remains inspectable */ }
    }
    const csrStat = assertRegularFile(root, csrPath, { maxBytes: MAX_CERT_BYTES });
    const newBytes = readBounded(root, newPath, MAX_CERT_BYTES);
    if ((csrStat.mode & 0o077) !== 0 || (lstatSync(oldPath).mode & 0o077) !== 0 || (lstatSync(newPath).mode & 0o077) !== 0) {
      fail('UNSAFE_FILE', 'Renewal artifact permissions are unsafe');
    }
    const renewed = validateLeafCertificate(newBytes, profile.ca_bytes, paths);
    validateKeyMatches(root, userKey, renewed);
    if (Date.parse(renewed.validTo) <= Date.parse(profile.certificate.validTo)
      || Date.parse(renewed.validTo) - Date.now() <= renewBeforeDays * DAY_MS) {
      fail('INVALID_CERTIFICATE', 'Renewed enrollment certificate does not extend the safe validity window');
    }
    certificates.push({
      org_id: paths.org_id,
      domain: paths.domain,
      target_path: relativePath(root, paths.cert),
      old_cert_path: relativePath(root, oldPath),
      csr_path: relativePath(root, csrPath),
      new_cert_path: relativePath(root, newPath),
      old_sha256: sha256(profile.certificate_bytes),
      new_sha256: sha256(newBytes),
      ca_sha256: sha256(profile.ca_bytes),
      old_valid_to: new Date(profile.certificate.validTo).toISOString(),
      new_valid_to: new Date(renewed.validTo).toISOString(),
    });
  }
  const plan: RenewalPlan = {
    schema: PLAN_SCHEMA,
    version: 1,
    status: 'prepared',
    created_at: createdAt,
    days,
    renew_before_days: renewBeforeDays,
    channel_block_sha256: publicState.channelHash,
    certificates,
  };
  const planPath = join(stage, 'plan.json');
  writePlan(planPath, plan, true);
  fsyncDirectory(stage);
  fsyncDirectory(renewalRoot);
  return {
    status: 'prepared', checked_at: checkedAt, days, renew_before_days: renewBeforeDays,
    certificates: publicInventory, plan_path: relativePath(root, planPath), prepared_at: createdAt,
    channel_block_sha256: publicState.channelHash,
  };
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key));
}

function parsePlan(root: string, planPath: string): { plan: RenewalPlan; path: string; stage: string } {
  if (typeof planPath !== 'string' || planPath.length === 0 || planPath.includes('\0')) fail('INVALID_PLAN', 'Invalid renewal plan path');
  const path = isAbsolute(planPath) ? resolve(planPath) : resolve(root, planPath);
  const renewalRoot = join(root, 'certificate-renewals');
  assertConfined(renewalRoot, path);
  const stage = dirname(path);
  if (basename(path) !== 'plan.json' || dirname(stage) !== renewalRoot
    || !/^renewal-[0-9]{14}-[a-f0-9]{16}$/.test(basename(stage))) fail('INVALID_PLAN', 'Renewal plan is not in a fixed renewal directory');
  assertRegularFile(root, path, { private: true, maxBytes: MAX_PLAN_BYTES });
  const stageStat = lstatSync(stage);
  const rootStat = lstatSync(renewalRoot);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || (stageStat.mode & 0o077) !== 0
    || !rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) fail('UNSAFE_FILE', 'Renewal plan directory is unsafe');
  let value: unknown;
  try { value = parseStrictJson(readFileSync(path)); } catch { return fail('INVALID_PLAN', 'Renewal plan cannot be decoded'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_PLAN', 'Renewal plan has an invalid schema');
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ['schema', 'version', 'status', 'created_at', 'days', 'renew_before_days', 'channel_block_sha256', 'certificates'], ['applied_at'])
    || record.schema !== PLAN_SCHEMA || record.version !== 1 || (record.status !== 'prepared' && record.status !== 'applied')
    || typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at))
    || (record.status === 'prepared' && record.applied_at !== undefined)
    || (record.status === 'applied' && (typeof record.applied_at !== 'string' || !Number.isFinite(Date.parse(record.applied_at))))
    || typeof record.channel_block_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.channel_block_sha256)
    || !Array.isArray(record.certificates) || record.certificates.length !== DEVELOPMENT_ORGANIZATIONS.length) {
    fail('INVALID_PLAN', 'Renewal plan has an invalid schema');
  }
  const days = validateInteger(record.days as number, 'days', 1, MAX_DAYS);
  const renewBeforeDays = validateInteger(record.renew_before_days as number, 'renewBeforeDays', 0, MAX_DAYS - 1);
  if (days <= renewBeforeDays) fail('INVALID_PLAN', 'Renewal plan validity window is invalid');
  return { plan: value as RenewalPlan, path, stage };
}

function validatePlanEntry(root: string, stage: string, entry: unknown, paths: ProfilePaths): RenewalPlanCertificate {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('INVALID_PLAN', 'Renewal certificate entry is invalid');
  const record = entry as Record<string, unknown>;
  const keys = ['org_id', 'domain', 'target_path', 'old_cert_path', 'csr_path', 'new_cert_path', 'old_sha256', 'new_sha256', 'ca_sha256', 'old_valid_to', 'new_valid_to'];
  if (!exactKeys(record, keys) || keys.some(key => typeof record[key] !== 'string')) fail('INVALID_PLAN', 'Renewal certificate entry is invalid');
  const expected = {
    org_id: paths.org_id,
    domain: paths.domain,
    target_path: relativePath(root, paths.cert),
    old_cert_path: relativePath(root, join(stage, stageName(paths, 'old-cert.pem'))),
    csr_path: relativePath(root, join(stage, stageName(paths, 'request.csr'))),
    new_cert_path: relativePath(root, join(stage, stageName(paths, 'new-cert.pem'))),
  };
  for (const [key, value] of Object.entries(expected)) if (record[key] !== value) fail('INVALID_PLAN', 'Renewal certificate paths do not match the fixed profile');
  for (const key of ['old_sha256', 'new_sha256', 'ca_sha256']) if (!/^[a-f0-9]{64}$/.test(record[key] as string)) fail('INVALID_PLAN', 'Renewal certificate hash is invalid');
  for (const key of ['old_valid_to', 'new_valid_to']) if (!Number.isFinite(Date.parse(record[key] as string))) fail('INVALID_PLAN', 'Renewal certificate date is invalid');
  return entry as RenewalPlanCertificate;
}

interface PreflightEntry {
  paths: ProfilePaths;
  entry: RenewalPlanCertificate;
  old_bytes: Buffer;
  new_bytes: Buffer;
  state: 'old' | 'new';
}

function preflightApply(root: string, parsed: ReturnType<typeof parsePlan>): PreflightEntry[] {
  const { plan, stage } = parsed;
  const publicState = loadPublicProfiles(root);
  if (publicState.channelHash !== plan.channel_block_sha256) fail('GENESIS_DRIFT', 'Channel genesis changed after renewal preparation');
  const byOrg = new Map<string, unknown>();
  for (const entry of plan.certificates) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as any).org_id !== 'string' || byOrg.has((entry as any).org_id)) fail('INVALID_PLAN', 'Renewal plan profiles are invalid');
    byOrg.set((entry as any).org_id, entry);
  }
  const byPublicOrg = new Map(publicState.profiles.map(profile => [profile.paths.org_id, profile]));
  return profilePaths(root).map(paths => {
    const entry = validatePlanEntry(root, stage, byOrg.get(paths.org_id), paths);
    const publicProfile = byPublicOrg.get(paths.org_id)!;
    if (sha256(publicProfile.ca_bytes) !== entry.ca_sha256) fail('CA_DRIFT', 'Development organization CA changed after renewal preparation');
    const oldPath = resolve(root, entry.old_cert_path);
    const newPath = resolve(root, entry.new_cert_path);
    const csrPath = resolve(root, entry.csr_path);
    const oldBytes = readBounded(root, oldPath, MAX_CERT_BYTES, { private: true });
    const newBytes = readBounded(root, newPath, MAX_CERT_BYTES, { private: true });
    readBounded(root, csrPath, MAX_CERT_BYTES, { private: true });
    if (sha256(oldBytes) !== entry.old_sha256 || sha256(newBytes) !== entry.new_sha256) fail('PLAN_DRIFT', 'Renewal artifacts changed after preparation');
    const oldCertificate = validateLeafCertificate(oldBytes, publicProfile.ca_bytes, paths, { allowExpired: true });
    const newCertificate = validateLeafCertificate(newBytes, publicProfile.ca_bytes, paths);
    if (new Date(oldCertificate.validTo).toISOString() !== entry.old_valid_to || new Date(newCertificate.validTo).toISOString() !== entry.new_valid_to
      || Date.parse(newCertificate.validTo) <= Date.parse(oldCertificate.validTo)
      || Date.parse(newCertificate.validTo) - Date.now() <= plan.renew_before_days * DAY_MS
      || !newCertificate.publicKey.export({ type: 'spki', format: 'der' }).equals(oldCertificate.publicKey.export({ type: 'spki', format: 'der' }))) {
      fail('INVALID_CERTIFICATE', 'Renewed enrollment certificate does not preserve the expected identity and validity');
    }
    const userKey = singlePrivateKey(root, paths.keystore);
    const caKey = singlePrivateKey(root, paths.ca_keystore);
    validateKeyMatches(root, userKey, oldCertificate);
    validateKeyMatches(root, userKey, newCertificate);
    validateKeyMatches(root, caKey, publicProfile.ca_certificate);
    const activeBytes = readBounded(root, paths.cert, MAX_CERT_BYTES);
    const activeHash = sha256(activeBytes);
    const state = activeHash === entry.old_sha256 ? 'old' : activeHash === entry.new_sha256 ? 'new' : fail('TARGET_DRIFT', 'Active enrollment certificate changed after renewal preparation');
    return { paths, entry, old_bytes: oldBytes, new_bytes: newBytes, state };
  });
}

export function applyRenewal(stateDir: string, planPath: string): ApplyRenewalResult {
  const root = stateRoot(stateDir);
  const parsed = parsePlan(root, planPath);
  const entries = preflightApply(root, parsed);
  const changedThisAttempt: PreflightEntry[] = [];
  try {
    for (const item of entries) {
      if (item.state === 'new') continue;
      changedThisAttempt.push(item);
      atomicWrite(item.paths.cert, item.new_bytes);
      const installed = readBounded(root, item.paths.cert, MAX_CERT_BYTES);
      if (sha256(installed) !== item.entry.new_sha256) fail('APPLY_FAILED', 'Renewed enrollment certificate was not installed');
    }
    const updated: RenewalPlan = { ...parsed.plan, status: 'applied', applied_at: new Date().toISOString() };
    writePlan(parsed.path, updated, false);
  } catch (error) {
    let rollbackFailed = false;
    for (const item of changedThisAttempt.reverse()) {
      try {
        atomicWrite(item.paths.cert, item.old_bytes);
        if (sha256(readBounded(root, item.paths.cert, MAX_CERT_BYTES)) !== item.entry.old_sha256) rollbackFailed = true;
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) fail('ROLLBACK_FAILED', 'Certificate renewal failed and rollback could not be verified');
    if (error instanceof CertificateMaintenanceError) throw error;
    fail('APPLY_FAILED', 'Certificate renewal could not be applied');
  }
  return {
    status: 'applied',
    changed: changedThisAttempt.length,
    // A resumed/idempotent apply cannot prove that every consumer reloaded
    // the installed certificate after a prior process interruption.
    restart_required: true,
    plan_path: relativePath(root, parsed.path),
  };
}
