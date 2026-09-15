import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDemoApp as createApp } from './application.ts';
import { getDevelopmentOrganization } from './organizations.ts';

const args = process.argv.slice(2).filter(arg => arg !== '--demo');
let port = 4317;
let dataDir = fileURLToPath(new URL('../../.data/demo', import.meta.url));
let selectedDataDir = false;
let mode = 'local-simulation';
let issuer: string | undefined;
let signerSocket: string | undefined;
let authenticationRequested = false;
let organizationInput: string | undefined;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--port') port = Number(args[++index]);
  else if (args[index] === '--data') { dataDir = resolve(args[++index] ?? ''); selectedDataDir = true; }
  else if (args[index] === '--ledger') mode = args[++index];
  else if (args[index] === '--oidc-development-issuer') { authenticationRequested = true; issuer = args[++index]; }
  else if (args[index] === '--signer-socket') { authenticationRequested = true; signerSocket = args[++index]; }
  else if (args[index] === '--organization') {
    if (organizationInput !== undefined || !args[index + 1]) throw new Error('Organization requires one value');
    organizationInput = args[++index];
  }
  else throw new Error('Unknown command line option; see the runtime guide');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
if (!['local-simulation', 'fabric-test-network'].includes(mode)) throw new Error('Unknown ledger mode');
if (authenticationRequested && (!issuer || !signerSocket || mode !== 'fabric-test-network')) throw new Error('OIDC development requires Fabric, an issuer and a separate signing socket');
const organization = organizationInput === undefined ? undefined : getDevelopmentOrganization(organizationInput);
if (organization && (!issuer || !signerSocket || mode !== 'fabric-test-network')) throw new Error('An organization scope requires authenticated Fabric and a separate signing socket');
if (!selectedDataDir && mode === 'fabric-test-network') dataDir = fileURLToPath(new URL('../../.data/fabric-web', import.meta.url));
if (!selectedDataDir && organization) dataDir = fileURLToPath(new URL(`../../.data/fabric-${organization.domain}`, import.meta.url));
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  const runtime = issuer && signerSocket
    ? await (await import('./auth-runtime.ts')).createDevelopmentAuthRuntime({ dataDir, issuer, socketPath: resolve(signerSocket), origin: `http://127.0.0.1:${port}`, organization })
    : mode === 'fabric-test-network' ? await (await import('./fabric-runtime.ts')).createFabricTestRuntime(dataDir) : {};
  app = await createApp({ dataDir, ...runtime });
  const address = await app.listen(port);
  console.log(`Knowledge Consensus Ledger: ${address}`);
  console.log(issuer ? 'OIDC development login · separate signing service · verified Fabric blocks' : mode === 'fabric-test-network' ? 'Fabric test network · verified peer blocks · fictional test identities' : 'Local simulation · fictional demo personas · no external model calls');
} catch {
  await app?.close();
  console.error('KCL could not start. Check the local port, data directory, and selected ledger connection.');
  process.exitCode = 1;
}
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await app?.close();
});
