# Fabric adapter packaging and smoke path

The Fabric adapter is intentionally separated from the core
and local tests. `packages/fabric/chaincode.ts` implements the fabric-shim
`Init`/`Invoke` boundary, while `packages/fabric/gateway.ts` wraps the
Gateway proposal/endorse/submit/status lifecycle and durable outbox.

The adapter was checked against the currently published package metadata on
2026-09-15:

- `fabric-shim` `2.5.8` (Node chaincode shim API)
- `@hyperledger/fabric-gateway` `1.12.1` (Node Gateway client API)

Reference API sources: [Fabric chaincode shim](https://hyperledger-fabric.readthedocs.io/en/latest/smartcontract/smartcontract.html),
[`fabric-shim` package](https://www.npmjs.com/package/fabric-shim), and
[Fabric Gateway Node API](https://hyperledger.github.io/fabric-gateway/main/api/node/).

They are pinned in the source manifests. They have not been downloaded or
executed in this workspace. Tests inject the SDK/shim boundary and exercise the
real domain engine. A real deployment still needs dependency installation,
lockfile review and validation against the actual peer/SDK versions.

## Chaincode package

Build the runnable JavaScript bundle and pinned public genesis with fixed
source paths:

```sh
node infra/fabric/build.mjs
```

The build uses Node's native TypeScript stripping and rewrites local `.ts`
imports to `.js`. The generated entrypoint constructs the domain engine,
pinned `infra/fabric/genesis.json`, pinned bootstrap identity, and real shim
`ClientIdentity` decoder before starting the dynamic `fabric-shim` loader.
The output includes a standalone `package.json` with `npm start` and a pinned
shim dependency. Its local modules were built and loaded on Node 26.5.0.
The build does not perform TypeScript static type checking. Use `--output DIR`
to produce a separate package directory; generated directories are not source.

The package helper delegates lifecycle packaging to the official `peer` CLI,
which creates Fabric's metadata/code package layout. It fails clearly when the
CLI is unavailable and does not download dependencies, read credentials, or
create identities:

```sh
sh infra/fabric/package-chaincode.sh infra/fabric/dist ./build/kcl-fabric.tar.gz
```

For a real network smoke test, install the pinned dependency in the generated
chaincode package, review the resulting lockfile, then lifecycle-package it
with the peer CLI. The peer starts it using `npm start` with the normal shim
connection arguments. `Init` accepts the standard `Init`
function argument without extra payload, rejects arbitrary first-user genesis
input, and only accepts the configured founder. The shim `ClientIdentity`
decoder extracts the authenticated MSP and `kcl.actor_id`/`kcl.actor_kind`
certificate attributes; command payload actor fields never become the source
of identity.

`Invoke` sends exactly one JSON command to the domain engine. The domain
engine owns `GetCommand`/idempotency state under the actor-organization and
`command_id` key, so the Fabric adapter does not invent a second idempotency
record or a second digest formula. Buffered writes are flushed only after the
engine succeeds; reads see prior buffered writes and otherwise go to the
ledger view. The bootstrap marker is `kcl:v1:bootstrap_manifest`.

## Gateway smoke path

The Gateway wrapper requires a caller-owned TLS gRPC client, identity
certificate and signer callback. It never reads credential files or private
keys. Install its optional dependencies with `npm install --prefix packages/fabric`
when preparing a real integration. Import `connectOfficialFabricGateway`,
`FabricGatewayTransport`, and `SqliteOutbox` from `packages/fabric/index.ts`;
the official connector implements the SDK proposal/endorse/submit/status calls.

Create one outbox database per channel and signing identity, and keep that
routing fixed during recovery. Supply `client`, `channel_id`, `chaincode_name`,
and `credentials: { msp_id, certificate, signer }` to the connector, then
`{ client: connectedClient, outbox }` to the transport. `execute()` accepts
`{ command_id, actor_org_id, type, input }`; organization metadata must match
the certificate MSP. Close the outbox, returned client, and caller-owned gRPC
client when finished. The HTTP demonstration server does not expose this
connector as a deployment mode.

Every proposal transaction ID and command digest is durably recorded before
submit. Gateway acknowledgement is not a commit. Only a trusted peer status
of `VALID` returns committed; timeout/unknown remains pending. An `INVALID`
duplicate is reconciled against the authoritative command record when the
payload digest matches, without reversing a successful command. The concrete
`SqliteOutbox` stores every attempt and `recoverPending()` rechecks status and
authoritative idempotency after process restart. Recovery reconstructs the
official commit using `gateway.newCommit()` and saved commit bytes. If submit
did not return a handle, it can consult the actor-bound committed idempotency
record. An unreachable peer keeps the attempt pending. An SDK result is decoded
only after VALID status or a matching committed idempotency record.

Before submitting document content, the organization gateway must perform the
explicit publication preview and recipient/configuration checks in the design.
Chaincode validation cannot prevent rejected content from remaining in a block.
The adapter does not perform automatic DLP.

No real Fabric network or Docker smoke test has been run in this workspace.
