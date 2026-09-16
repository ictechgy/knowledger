import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createProjectTemplate } from '../../packages/config/template.ts';

function workspaceConfig(channelId = 'knowledger-package-test', orgCount = 2) {
  const config = createProjectTemplate(Array.from({length:orgCount},(_,index)=>`Org${index+1}MSP`),'package-test');
  config.ledger.channel_id=channelId;config.genesis.channel_id=channelId;
  for(const policy of config.genesis.policies)policy.channel_id=channelId;
  return config;
}

async function buildPackage(t, args, config) {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-build-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'with spaces', 'chaincode');
  const configPath = join(directory, 'workspace.json');
  if (config) writeFileSync(configPath, JSON.stringify(config));
  const build = spawnSync(process.execPath, ['infra/fabric/build.mjs', ...args(configPath, output)], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const manifest = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'));
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.scripts.start, 'node entrypoint.mjs');
  assert.equal(manifest.dependencies['fabric-shim'], '2.5.8');
  const lock = JSON.parse(readFileSync(join(output, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies['fabric-shim'], manifest.dependencies['fabric-shim']);
  assert.equal(lock.packages['node_modules/fabric-shim'].version, '2.5.8');
  assert.match(lock.packages['node_modules/fabric-shim'].integrity, /^sha512-/);
  const module = await import(pathToFileURL(join(output, 'packages/fabric/chaincode.js')).href);
  assert.equal(typeof module.FabricChaincode, 'function');
  const entrypoint = readFileSync(join(output, 'entrypoint.mjs'), 'utf8');
  assert.equal(entrypoint.includes('../../packages/'), false);
  assert.equal(entrypoint.includes('.ts"'), false);
  return { output, entrypoint };
}

test('chaincode build creates a standalone Node package from a generic two-organization config', async t => {
  const { output } = await buildPackage(t, (configPath, outputPath) => ['--config', configPath, '--output', outputPath], workspaceConfig());
  const genesis = JSON.parse(readFileSync(join(output, 'genesis.json'), 'utf8'));
  const bootstrap = JSON.parse(readFileSync(join(output, 'bootstrap-identity.json'), 'utf8'));
  assert.deepEqual([...new Set(genesis.identities.map((identity) => identity.org_id))], ['Org1MSP', 'Org2MSP']);
  assert.deepEqual(bootstrap, { msp_id: 'Org1MSP', actor_id: 'maintainer', actor_kind: 'human' });
  assert.equal(readFileSync(join(output, 'entrypoint.mjs'), 'utf8').includes('local-development'), false);
});

test('explicit demo mode retains the fixture genesis and founder descriptor', async t => {
  const { output } = await buildPackage(t, (_configPath, outputPath) => ['--demo', '--output', outputPath]);
  const genesis = JSON.parse(readFileSync(join(output, 'genesis.json'), 'utf8'));
  const bootstrap = JSON.parse(readFileSync(join(output, 'bootstrap-identity.json'), 'utf8'));
  assert.equal(genesis.channel_id, 'kcl-demo');
  assert.deepEqual(bootstrap, { msp_id: 'FulfillmentMSP', actor_id: 'person-fulfillment-owner', actor_kind: 'human' });
});

test('generic packaging preserves an alternate four-organization membership', async t => {
  const { output } = await buildPackage(t, (configPath, outputPath) => ['--config', configPath, '--output', outputPath], workspaceConfig('knowledger-four-org', 4));
  const genesis = JSON.parse(readFileSync(join(output, 'genesis.json'), 'utf8'));
  assert.equal(genesis.identities.length, 4);
  assert.deepEqual(genesis.identities.map((identity) => identity.org_id), ['Org1MSP', 'Org2MSP', 'Org3MSP', 'Org4MSP']);
});

test('build rejects a mismatched ledger channel or unregistered founder before writing a package', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-build-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = workspaceConfig('knowledger-config-channel');
  config.ledger.channel_id = 'wrong-channel';
  const configPath = join(directory, 'workspace.json');
  writeFileSync(configPath, JSON.stringify(config));
  const build = spawnSync(process.execPath, ['infra/fabric/build.mjs', '--config', configPath, '--output', join(directory, 'output')], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' });
  assert.notEqual(build.status, 0);
  assert.match(`${build.stdout}\n${build.stderr}`, /channel/);
});
