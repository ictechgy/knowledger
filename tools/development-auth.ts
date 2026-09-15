/** One-command local OIDC + separate signer + Fabric application profile. */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startDevelopmentIssuer } from '../packages/auth/development-issuer.ts';
import { createDevelopmentAuthRuntime } from '../apps/api/development-auth-runtime.ts';
import { createApp } from '../apps/api/server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
let port = 4319;
let issuerPort = 4320;
let dataDir = join(root, '.data/fabric-login');
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--port') port = Number(process.argv[++index]);
  else if (process.argv[index] === '--issuer-port') issuerPort = Number(process.argv[++index]);
  else if (process.argv[index] === '--data') dataDir = resolve(process.argv[++index] ?? '');
  else throw new Error('Unknown development login option');
}
if (![port, issuerPort].every(value => Number.isInteger(value) && value > 0 && value <= 65535) || port === issuerPort) throw new Error('Use distinct valid app and issuer ports');

let signer: ChildProcess | undefined;
let issuer: Awaited<ReturnType<typeof startDevelopmentIssuer>> | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let socketDirectory: string | undefined;
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { await app?.close(); }
  finally {
    try { await issuer?.close(); }
    finally {
      if (signer && signer.exitCode === null) {
        const exited = new Promise<void>(resolveExit => signer!.once('exit', () => resolveExit()));
        signer.kill('SIGTERM'); await exited;
      }
      if (socketDirectory) { try { rmdirSync(socketDirectory); } catch { /* Preserve a directory that is not empty. */ } }
    }
  }
}

try {
  // Short, owner-only Unix socket path; no private key is copied here.
  socketDirectory = mkdtempSync('/tmp/kcl-signing-');
  const socketPath = join(socketDirectory, 'sign.sock');
  signer = spawn(process.execPath, ['infra/fabric/signing-service.ts', '--socket', socketPath], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  signer.stderr?.on('data', () => { /* Do not relay arbitrary crypto/library diagnostics. */ });
  let signerError = false;
  signer.once('error', () => { signerError = true; });
  for (let attempt = 0; !existsSync(socketPath); attempt++) {
    if (signerError || signer.exitCode !== null || attempt >= 50) throw new Error('Development signing service could not start');
    await delay(100);
  }
  issuer = await startDevelopmentIssuer({ port: issuerPort, redirectUri: `http://127.0.0.1:${port}/auth/callback` });
  const runtime = await createDevelopmentAuthRuntime({ dataDir, origin: `http://127.0.0.1:${port}`, issuer: issuer.issuer, socketPath });
  app = await createApp({ dataDir, ...runtime });
  const address = await app.listen(port);
  console.log(`KCL development login: ${address}`);
  console.log('Local OIDC accounts · separate signing process · actual Fabric ledger');
  signer.once('exit', () => { if (!stopping) { console.error('Signing service stopped; shutting down the development profile.'); process.exitCode = 1; void stop(); } });
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
} catch {
  console.error('Development login could not start. Check Fabric, dependency installation, and selected ports.');
  process.exitCode = 1;
  await stop();
}
