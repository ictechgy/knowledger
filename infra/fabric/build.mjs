import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../../packages/domain/index.ts";
import { loadProjectConfiguration } from "../../packages/config/project.ts";

const root = fileURLToPath(new URL('../..', import.meta.url));
const usage = 'Usage: node infra/fabric/build.mjs (--config PATH | --demo) [--output PATH]';

function fail(message) {
  throw new Error(`${message}\n${usage}`);
}

function parseArgs(argv) {
  if (argv.length === 0) fail('A workspace configuration or explicit --demo mode is required');
  let mode;
  let configPath;
  let outputPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--demo') {
      if (mode || configPath) fail('Choose exactly one of --config or --demo');
      mode = 'demo';
    } else if (argument === '--config') {
      if (mode || configPath || !argv[index + 1]) fail('A single --config PATH is required');
      mode = 'config';
      configPath = argv[++index];
    } else if (argument === '--output') {
      if (outputPath || !argv[index + 1]) fail('A single --output PATH is allowed');
      outputPath = argv[++index];
    } else {
      fail(`Unsupported argument: ${argument}`);
    }
  }
  if (!mode) fail('A workspace configuration or explicit --demo mode is required');
  return { mode, configPath, outputPath };
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function pinnedBootstrap(genesis, bootstrap) {
  const identity = genesis.identities.find((candidate) => candidate.org_id === bootstrap.org_id && candidate.actor_id === bootstrap.actor_id && candidate.kind === bootstrap.kind);
  if (!identity) fail('bootstrap_actor must be a registered human identity in genesis');
  return { msp_id: identity.org_id, actor_id: identity.actor_id, actor_kind: identity.kind };
}

async function readJson(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
  }
  return assertRecord(parsed, label);
}

async function loadInput(parsed) {
  if (parsed.mode === 'demo') {
    const genesis = await readJson(resolve(root, 'examples/order-workflow/genesis.json'), 'demo genesis');
    const demo = await readJson(resolve(root, 'examples/order-workflow/bootstrap.json'), 'demo bootstrap configuration');
    const validatedGenesis = validateConfig(genesis);
    if (demo.channel_id !== validatedGenesis.channel_id) fail('demo bootstrap channel_id differs from genesis');
    return { genesis: validatedGenesis, bootstrap: pinnedBootstrap(validatedGenesis, demo.bootstrap_actor) };
  }
  const config = loadProjectConfiguration(resolve(process.cwd(), parsed.configPath));
  return { genesis: config.genesis, bootstrap: pinnedBootstrap(config.genesis, config.bootstrap_actor) };
}

async function copyTypeScript(sourceRelative, destinationRelative, output) {
  const source = resolve(root, sourceRelative);
  const destination = resolve(output, destinationRelative.replace(/\.ts$/u, '.js'));
  let code = await readFile(source, 'utf8');
  code = stripTypeScriptTypes(code, { mode: 'strip' }).replace(/(from\s+["'][^"']+)\.ts(["'])/gu, '$1.js$2');
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, code);
}

const parsed = parseArgs(process.argv.slice(2));
const { genesis, bootstrap } = await loadInput(parsed);
const output = resolve(parsed.outputPath ?? resolve(root, 'infra/fabric/dist'));

await copyTypeScript('packages/domain/index.ts', 'packages/domain/index.ts', output);
for (const name of ['canonical', 'chaincode-loader', 'chaincode', 'types']) {
  await copyTypeScript(`packages/fabric/${name}.ts`, `packages/fabric/${name}.ts`, output);
}
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'genesis.json'), `${JSON.stringify(genesis, null, 2)}\n`);
await writeFile(resolve(output, 'bootstrap-identity.json'), `${JSON.stringify(bootstrap, null, 2)}\n`);
await writeFile(resolve(output, 'package.json'), await readFile(resolve(root, 'infra/fabric/package.json')));
await writeFile(resolve(output, 'package-lock.json'), await readFile(resolve(root, 'infra/fabric/package-lock.json')));
let entrypoint = await readFile(resolve(root, 'infra/fabric/entrypoint.mjs'), 'utf8');
entrypoint = entrypoint.replaceAll('../../packages/', './packages/').replaceAll('.ts"', '.js"');
await writeFile(resolve(output, 'entrypoint.mjs'), entrypoint);
console.log(`built ${output}`);
