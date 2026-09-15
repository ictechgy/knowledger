import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) throw new Error('Usage: node infra/fabric/build.mjs [--output directory]');
const output = resolve(args[1] ?? resolve(root, 'infra/fabric/dist'));

async function copyTypeScript(sourceRelative, destinationRelative) {
  const source = resolve(root, sourceRelative);
  const destination = resolve(output, destinationRelative.replace(/\.ts$/u, ".js"));
  let code = await readFile(source, "utf8");
  code = stripTypeScriptTypes(code, { mode: "strip" }).replace(/(from\s+["'][^"']+)\.ts(["'])/gu, "$1.js$2");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, code);
}

await copyTypeScript("packages/domain/index.ts", "packages/domain/index.ts");
for (const name of ["canonical", "chaincode-loader", "chaincode", "types"]) {
  await copyTypeScript(`packages/fabric/${name}.ts`, `packages/fabric/${name}.ts`);
}
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "genesis.json"), await readFile(resolve(root, "infra/fabric/genesis.json")));
await writeFile(resolve(output, 'package.json'), await readFile(resolve(root, 'infra/fabric/package.json')));
await writeFile(resolve(output, 'package-lock.json'), await readFile(resolve(root, 'infra/fabric/package-lock.json')));
let entrypoint = await readFile(resolve(root, "infra/fabric/entrypoint.mjs"), "utf8");
entrypoint = entrypoint.replaceAll("../../packages/", "./packages/").replaceAll(".ts\"", ".js\"");
await writeFile(resolve(output, "entrypoint.mjs"), entrypoint);
console.log(`built ${output}`);
