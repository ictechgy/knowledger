import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './server.ts';

const args = process.argv.slice(2);
let port = 4317;
let dataDir = fileURLToPath(new URL('../../.data/demo', import.meta.url));
let selectedDataDir = false;
let mode = 'local-simulation';
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--port') port = Number(args[++index]);
  else if (args[index] === '--data') { dataDir = resolve(args[++index] ?? ''); selectedDataDir = true; }
  else if (args[index] === '--ledger') mode = args[++index];
  else throw new Error('Usage: npm start -- [--port 4317] [--data directory] [--ledger local-simulation|fabric-test-network]');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
if (!['local-simulation', 'fabric-test-network'].includes(mode)) throw new Error('Unknown ledger mode');
if (!selectedDataDir && mode === 'fabric-test-network') dataDir = fileURLToPath(new URL('../../.data/fabric-web', import.meta.url));
let app: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  const runtime = mode === 'fabric-test-network' ? await (await import('./fabric-test-runtime.ts')).createFabricTestRuntime(dataDir) : {};
  app = await createApp({ dataDir, ...runtime });
  const address = await app.listen(port);
  console.log(`Knowledge Consensus Ledger: ${address}`);
  console.log(mode === 'fabric-test-network' ? 'Fabric test network · verified peer blocks · fictional test identities' : 'Local simulation · fictional demo personas · no external model calls');
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
