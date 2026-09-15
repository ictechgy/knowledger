import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('chaincode build creates a standalone Node package with pinned shim and loadable modules', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kcl-build-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'with spaces', 'chaincode');
  const build = spawnSync(process.execPath, ['infra/fabric/build.mjs', '--output', output], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const manifest = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'));
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.scripts.start, 'node entrypoint.mjs');
  assert.equal(manifest.dependencies['fabric-shim'], '2.5.8');
  const module = await import(pathToFileURL(join(output, 'packages/fabric/chaincode.js')).href);
  assert.equal(typeof module.FabricChaincode, 'function');
  const entrypoint = readFileSync(join(output, 'entrypoint.mjs'), 'utf8');
  assert.equal(entrypoint.includes('../../packages/'), false);
  assert.equal(entrypoint.includes('.ts"'), false);
});
