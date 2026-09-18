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

They are installed and pinned, including transitive dependencies in committed
lockfiles. The official shim argument/response API and Gateway deadline/retry
path are exercised in optional SDK tests. Root tests still run without these
dependencies; SDK-specific tests explicitly skip when the packages are absent.
The pinned dependencies currently report zero known vulnerabilities in npm audit.
That result is an advisory-database check, not a security certification.

## Chaincode package

Build the runnable JavaScript bundle and pinned public genesis with fixed
source paths:

```sh
node infra/fabric/build.mjs --config knowledger.config.json
# Explicit example:
node infra/fabric/build.mjs --demo
```

The build uses Node's native TypeScript stripping and rewrites local `.ts`
imports to `.js`. The generated entrypoint constructs the domain engine,
validated configuration genesis (or explicit `examples/order-workflow/genesis.json`), pinned bootstrap identity, and real shim
`ClientIdentity` decoder before starting the dynamic `fabric-shim` loader.
The output includes standalone `package.json` and `package-lock.json` files with
`npm start` and a pinned shim dependency. Its local modules were built and loaded
on Node 24.18.0; the pinned nodeenv image provides Node 22.12.0.
The build does not perform TypeScript static type checking. Use `--output DIR`
to produce a separate package directory; generated directories are not source.

The package helper delegates lifecycle packaging to the official `peer` CLI,
which creates Fabric's metadata/code package layout. It fails clearly when the
CLI is unavailable and does not download dependencies, read credentials, or
create identities:

```sh
sh infra/fabric/package-chaincode.sh infra/fabric/dist ./build/kcl-fabric.tar.gz
```

For a real network smoke test, run `npm ci --prefix infra/fabric/dist` after
building, then lifecycle-package it with the peer CLI. Official peer 2.5.16
packaging has been verified locally, including the `metadata.json` and
`code.tar.gz` layout and exclusion of credentials and `node_modules`.
The peer starts it using `npm start` with the normal shim
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
client when finished. Every evaluate, endorse, submit and commit-status RPC has
a fresh deadline (defaults: 5, 15, 15 and 30 seconds). `timeouts_ms` can override
these durations with positive integer milliseconds. A peer that never responds
therefore cannot prevent the outbox from retaining an unresolved attempt.
The HTTP demonstration server does not expose this
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

`infra/fabric/signing-service.ts` is the organisation signing gateway's
development form: a Unix-socket process that holds private keys outside the
application. Clients connect with `createRemoteSigner` from
`packages/fabric/remote-signer.ts` and send `{ operation: "sign", key_id,
digest, certificate }`. A request may also carry an `attestation` object binding
`org_id`, `actor_id`, `actor_kind`, `command_id`, `command_type`, `command_digest`,
`phase` and a required `tx_id`; read-only signing carries the shorter
`phase: "query"` form without a command binding. When present, the service
verifies the actor against the certificate's `kcl.actor_*` attributes and the
key's configured `org_id` before signing; key references may set
`allowed_actor_kinds` (default `["human"]`) so agent identities cannot obtain
attested signatures. `require_attestation: true` refuses unattested requests and
requires an `org_id` binding, so no client-claimed organisation is ever signed
into evidence; the development keys in `examples/order-workflow` enable it.
Each attested signature produces an `attestation_signature` receipt over the
canonical decision payload — the signer verifies it cryptographically and
rejects missing or forged receipts, and may hand the verified receipt and its
canonical evidence to an `onAttestationReceipt` callback so the application can
retain the proof. The callback must be synchronous — a promise return fails
the signing request. With `--audit-log ABSOLUTE_PATH` the service also appends a
JSONL audit record the organisation retains as its testimony. The service
sees only an opaque digest, so the attested phase and command binding are
caller-asserted evidence; auditors reconcile each record's `tx_id`/digest
against the ledger (a write signed under a `query` claim appears on the ledger
without a matching attested transaction). An operational gateway re-derives
the binding from the proposal bytes before signing. Attested keys fail fast at
load when the certificate's `actor_kind` is outside `allowed_actor_kinds` or
the key is not EC (receipts are ECDSA evidence).
`--audit-log` is mandatory whenever an organisation-bound key is configured:
without the service-side record a receipt cannot be reconciled and a caller
able to drive the socket could mint forged evidence undetected, so the
service refuses to start such a key without it — a bare key with no
`org_id`/`require_attestation` serves only unattested requests and may start
without one. The development wrapper derives its log at
`signing-audit/audit.jsonl` beside the socket when no path is given. A record that throws mid-write can
leave a partial trailing line; consumers should discard a trailing non-JSON
line rather than the file. The audit file must not
collide with any configured key, certificate, socket or signing configuration
path — including hard links — and a non-regular target is refused before
open; a pre-existing file must be a regular file with mode 600 and a single
link, and a fresh path is created exclusively so a raced-in file fails the
open rather than being adopted. The file is opened once with no-follow
semantics, validated by descriptor,
appended with a single write call per record, flushed before the response is
acknowledged and closed with the service. Record timestamps are service-asserted
operational metadata, not part of the signed evidence. The gateway client
serialises every signer-bearing SDK call on a connection — endorse, submit,
status and evaluate — installing the attestation inside the same critical
section the signer consumes it from, so a concurrent read can never overwrite
or steal an in-flight decision attestation. A context may be claimed by a
single serializer, which releases the claim when the connection closes. The
qscc lookup gateway signs through a dedicated slot and signer separate from
the write path, and the remote signer consumes its slot once per request, so
the receipt binds the exact command decision and transaction ID without stale
reuse. qscc reads are attested under one configured binding's identity (the
API runtime uses the first; the example fixture prefers the second when
present), so audit consumers should read them as service reads by that
signing identity rather than user actions.

Before submitting document content, the organization gateway must perform the
explicit publication preview and recipient/configuration checks in the design.
Chaincode validation cannot prevent rejected content from remaining in a block.
The adapter does not perform automatic DLP.

## Local three-organization network

The existing web UI can use this network with `npm run start:fabric`. It has a
durable SQLite block projection and authenticated test signer routes. See the
[Fabric web profile](../../docs/12-FABRIC-WEB.md) for setup, restart semantics,
HTTP pending/failure behavior, and the boundary with production authentication.

`test-network.py` delegates to `examples/order-workflow/test-network.py`, which prepares a fixed `kcl-demo` channel with SalesMSP,
FulfillmentMSP and SettlementMSP peers and three Raft orderers. All endpoints
published to the host bind to loopback. The nodes share one local Docker host;
this does not demonstrate independent organization administration or production
fault tolerance. Peers use the Docker socket to launch the Node chaincode.

The first integration profile pins Fabric **2.5.16**, shim **2.5.8**, Gateway
**1.12.1**, and nodeenv **2.5.8**. The v3/BFT reference profile is a separate
validation stage; see [the decision](../../docs/10-IMPLEMENTATION-DECISIONS.md).

| Image | Verified repository digest |
| --- | --- |
| `hyperledger/fabric-peer:2.5.16` | `sha256:09ee75042de9983bfde31ca88a5bf033386351f10a990e4c48264ee50172dee0` |
| `hyperledger/fabric-orderer:2.5.16` | `sha256:e322c57331d37e0a35ffae3cb3d3265a0e852211c0f801f2514cc15b964ffc93` |
| `hyperledger/fabric-nodeenv:2.5.8` | `sha256:17e2d447ca0de5b4e3f6950a1c9b24ecfdeecdd90e111e11d771970d35159bf1` |

The macOS arm64 harness expects the [official Fabric 2.5.16 release](https://github.com/hyperledger/fabric/releases/tag/v2.5.16)
extracted under `.tools/fabric-2.5.16` and the [Compose 5.5.1 standalone binary](https://github.com/docker/compose/releases/tag/v5.5.1)
at `.tools/docker-compose`, with a running `colima` Docker context. Archive SHA-256:
`9f226e9c7e40f81b4f76db349438f8742beeb43d88519b73f2095e4f65f3ab42`;
Compose binary SHA-256: `998735c9b6fe68a4f05895e6ea73d71ad06f9fc7046383ad89e47346781b6af5`.
Downloaded tools, images, generated data and identities are excluded from Git.
Use Node 24 or later in `PATH` and the `openssl` CLI.

```sh
npm ci --prefix packages/fabric --ignore-scripts
npm run fabric:prepare  # public configuration only; no credentials
```

After authorization to generate and use disposable test credentials:

```sh
npm run fabric:up       # fresh test MSP/TLS identities, lifecycle deployment, Init
npm run fabric:smoke    # real Gateway writes and peer full-block verification
npm run fabric:stop     # stop nodes; preserve ledgers and identities
```

The harness uses only `.data/fabric-smoke/crypto`. `cryptogen` creates disposable
CAs; OpenSSL issues 90-day fixture client certificates with the required
`kcl.actor_id` and `kcl.actor_kind` attributes. This emulates fixture identities
and does not integrate Fabric CA enrollment, SSO or a production key manager.
Existing test identities are never overwritten by `fabric:up`.
Use `npm run fabric:certs:check` to inspect public certificate expiration and
`fabric:certs:prepare` / `fabric:certs:apply` to renew the three enrollment
certificates with their existing keys. Follow the [renewal procedure](../../docs/27-TEST-CERTIFICATES.md)
and restart affected applications and signers after applying a plan.
`fabric:deploy` resumes deployment after identity generation. It queries existing
channels and committed definitions, verifies each organization's exact package
and approval, and detects initialization from the peer. A local deployment file
is not treated as commit proof. Incompatible definitions/packages stop deployment.
There is no automatic volume or credential deletion command.

The smoke script uses fictional document fixtures. It checks publication,
organization approvals, activation, unauthorized endorsement rejection, outbox
recovery after a child process exits, injected lost submit responses, competing
transactions producing a real MVCC INVALID result, and a fence followed by
dependency withdrawal in the same block. Source content and resolution are
checked against peer full blocks. It writes non-secret results to
`.data/fabric-smoke/evidence.json` only after all assertions pass.
Verified peer blocks are saved under `.data/fabric-smoke/blocks` for local replay.
Before withdrawal, retries reuse the original application command receipts and
use new run IDs for fault probes.
A completed fixture cannot be rerun as a fresh scenario after its withdrawal.

**Executed on 2026-09-15:** lifecycle and all smoke assertions passed after fixes
to test certificate issuance, deployment resume, and Fabric Init metadata handling.
All three peers agreed at height 47. Block 46 contained the VALID fence at index
0 and dependency withdrawal at index 1; the resolver withheld the dependent
document after processing the complete block. Replaying peer blocks 0–46 reproduced
the same state and header hash. Deployment resume added no new blocks.
See [the execution record](../../docs/VALIDATION.md).

## Verified in-memory block reader

After installing adapter dependencies, import `FabricBlockProjector` directly
from [block-projector.ts](../../packages/fabric/block-projector.ts). Configure
`channel_id`, `chaincode_name`, `chaincode_version` (default `0.1.0`), and the pinned `public_genesis`, then pass each
peer-delivered full block's serialized bytes to `applyBlock()`, starting at block
zero. `read(key)` returns a cloned value at the end of the last complete block;
`checkpoint()` records its number and Fabric ASN.1 header hash.

The reader verifies contiguous numbers, previous/data hashes, complete final
validation codes, known transaction types and write schemas. It ignores INVALID
transaction effects, admits the initial channel configuration and lifecycle
transactions, and stops on later channel reconfiguration or unsupported writes.
Fabric's reserved Init marker is accepted only for the pinned chaincode version
with the Knowledger bootstrap in the same transaction, and is kept out of domain state.
All state changes and the cursor advance together only after the entire block
passes. Synthetic protobuf tests use the real domain engine to check resolution
after a fence and withdrawal in one block; independent OpenSSL ASN.1 fixtures
check header hashes across integer byte boundaries.

The caller must supply blocks through an authenticated peer delivery connection.
The reader does not independently verify peer identity, block signatures or
endorsement signatures. [SqliteFabricProjection](../../packages/fabric/sqlite-projection.ts)
adds an atomic raw block journal, state/history/cursor storage, replay on restart,
and cache integrity checks. [FabricApplicationLedger](../../packages/fabric/application-ledger.ts)
connects that store to Gateway commands and request-driven peer catch-up for the
web API. Historical reads retain the exact transaction position. Large-ledger
performance and independent operator deployment remain unverified.
