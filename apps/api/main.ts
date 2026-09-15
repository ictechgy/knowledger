import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './server.ts';

const args = process.argv.slice(2);
let port = 4317;
let dataDir = fileURLToPath(new URL('../../.data/demo', import.meta.url));
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--port') port = Number(args[++index]);
  else if (args[index] === '--data') dataDir = resolve(args[++index] ?? '');
  else throw new Error('Usage: npm start -- [--port 4317] [--data /path/to/local-data]');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
const app = await createApp({ dataDir });
try {
  const address = await app.listen(port);
  console.log(`Knowledge Consensus Ledger: ${address}`);
  console.log('Local simulation · fictional demo personas · no external model calls');
} catch {
  await app.close();
  console.error('KCL could not start. Check the selected local port and data directory.');
  process.exitCode = 1;
}
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
});
