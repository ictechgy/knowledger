import test from "node:test";
import assert from "node:assert/strict";
import { idempotencyDigest } from "../../packages/domain/index.ts";
import { decisionAttestation, queryAttestation, FabricGatewayTransport, connectOfficialFabricGateway, type GatewayAttestation } from "../../packages/fabric/gateway.ts";
import { assertSigningAttestation, attestationSlot, createAttestationSerializer, releaseAttestationSerializer, type Attestation, type SigningAttestation, type SigningAttestationContext } from "../../packages/fabric/remote-signer.ts";
import { SqliteOutbox } from "../../packages/fabric/sqlite-outbox.ts";
import type { DurableOutbox, FabricGatewayClient, GatewayCommand, GatewayProposal } from "../../packages/fabric/types.ts";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeOutbox implements DurableOutbox {
  readonly attempts = new Map<string, { status: string; detail?: string }>();
  readonly events: string[] = [];
  async recordAttempt(attempt: { tx_id: string; status: "pending" }): Promise<void> { this.events.push(`record:${attempt.tx_id}`); this.attempts.set(attempt.tx_id, attempt); }
  async updateAttempt(tx_id: string, update: { status: "pending" | "endorsed" | "acknowledged" | "valid" | "invalid" | "reconciled" | "unknown"; detail?: string }): Promise<void> { this.events.push(`update:${tx_id}:${update.status}`); this.attempts.set(tx_id, update); }
}

function command(id: string): GatewayCommand { return { command_id: id, type: "fence", input: { nonce: id }, actor_org_id: "SalesMSP" }; }

test("ACK and UNKNOWN remain pending until peer status is VALID", async () => {
  const outbox = new FakeOutbox();
  let statusCalls = 0;
  const client: FabricGatewayClient = {
    async newProposal(): Promise<GatewayProposal> { return { tx_id: "tx-1", async endorse() { return { async submit() { return { acknowledged: true }; } }; } }; },
    async getStatus() { statusCalls += 1; return statusCalls === 1 ? { status: "UNKNOWN" } : { status: "VALID", block_number: 4, transaction_index: 2 }; },
  };
  const transport = new FabricGatewayTransport({ client, outbox });
  const first = await transport.execute(command("cmd-1"));
  assert.equal(first.status, "pending");
  assert.equal(outbox.events[0], "record:tx-1");
  const second = await transport.execute(command("cmd-1"));
  assert.equal(second.status, "valid");
});

test("committed result is read only after VALID status", async () => {
  const outbox = new FakeOutbox();
  const events: string[] = [];
  const client: FabricGatewayClient = {
    async newProposal(): Promise<GatewayProposal> { return { tx_id: "tx-result", async endorse() { return {
      async submit() { events.push("submit"); return {}; },
      async getResult() { events.push("result"); return { accepted: true }; },
      async getCommitBytes() { return new Uint8Array([1]); },
    }; } }; },
    async getStatus() { events.push("status"); return { status: "VALID" }; },
  };
  const result = await new FabricGatewayTransport({ client, outbox }).execute(command("cmd-result"));
  assert.equal(result.status, "valid");
  assert.deepEqual(result.result, { accepted: true });
  assert.deepEqual(events, ["submit", "status", "result"]);
});

test("INVALID duplicate reconciles an authoritative idempotency result", async () => {
  const outbox = new FakeOutbox();
  const cmd = command("cmd-2");
  const digest = idempotencyDigest({ command_id: cmd.command_id, type: cmd.type, input: cmd.input });
  const client: FabricGatewayClient = {
    async newProposal(): Promise<GatewayProposal> { return { tx_id: "tx-2", async endorse() { return { async submit() {} }; } }; },
    async getStatus() { return { status: "INVALID", code: "MVCC_READ_CONFLICT" }; },
    async getAuthoritativeCommandResult() { return { payload_digest: digest, result: { committed: true } }; },
  };
  const result = await new FabricGatewayTransport({ client, outbox }).execute(cmd);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.result, { committed: true });
  assert.equal(outbox.attempts.get("tx-2")?.status, "reconciled");
});

test("an unavailable INVALID reconciliation query remains pending", async () => {
  const outbox = new FakeOutbox();
  const client: FabricGatewayClient = {
    async newProposal(): Promise<GatewayProposal> { return { tx_id: "tx-3", async endorse() { return { async submit() {} }; } }; },
    async getStatus() { return { status: "INVALID", code: "MVCC_READ_CONFLICT" }; },
    async getAuthoritativeCommandResult() { throw new Error("peer unavailable"); },
  };
  const result = await new FabricGatewayTransport({ client, outbox }).execute(command("cmd-3"));
  assert.equal(result.status, "pending");
  assert.equal(outbox.attempts.get("tx-3")?.status, "acknowledged");
});

test("gateway construction requires caller-provided credential buffers", async () => {
  await assert.rejects(() => connectOfficialFabricGateway({ client: {}, channel_id: 'kcl-demo', chaincode_name: 'kcl', credentials: { msp_id: 'SalesMSP', certificate: new Uint8Array(), signer: async digest => digest } }), /identity/);
});

test('authorization revoked after endorsement prevents submission', async () => {
  let allowed = true;
  let submissions = 0;
  const client = await connectOfficialFabricGateway({ client: {}, channel_id: 'kcl-demo', chaincode_name: 'kcl',
    credentials: { msp_id: 'SalesMSP', certificate: new Uint8Array([1]), signer: async digest => digest },
    authorize: async () => { if (!allowed) throw new Error('Authorization revoked'); },
    module: { connect() { return { getNetwork: () => ({ getContract: () => ({
      newProposal: () => ({ getTransactionId: () => 'tx-revoked', endorse: async () => ({ submit: async () => { submissions++; throw new Error('Submission must not occur'); }, getResult: () => new Uint8Array() }) }),
      evaluateTransaction: async () => new Uint8Array(),
    }) }) }; } },
  });
  const proposal = await client.newProposal(command('command-revoked'));
  const endorsement = await proposal.endorse(); allowed = false;
  await assert.rejects(() => endorsement.submit(), /Authorization cancelled/);
  assert.equal(submissions, 0);
});

test('an authorization-cancelled attempt is terminal and is not queried during recovery', async () => {
  const outbox = new SqliteOutbox(':memory:');
  let allowed = true; let reads = 0; let submissions = 0;
  const denied = Object.assign(new Error('Authorization revoked'), { code: 'AUTHORIZATION_REVOKED', status: 403 });
  const client = await connectOfficialFabricGateway({ client: {}, channel_id: 'kcl-demo', chaincode_name: 'kcl',
    credentials: { msp_id: 'SalesMSP', certificate: new Uint8Array([1]), signer: async digest => digest },
    authorize: async () => { if (!allowed) throw denied; },
    module: { connect() { return { getNetwork: () => ({ getContract: () => ({
      newProposal: () => ({ getTransactionId: () => 'tx-cancelled', endorse: async () => { allowed = false; return { submit: async () => { submissions++; throw new Error('Not submitted'); }, getResult: () => new Uint8Array() }; } }),
      evaluateTransaction: async () => { reads++; return new Uint8Array(); },
    }) }) }; } },
  });
  const transport = new FabricGatewayTransport({ client, outbox });
  try {
    await assert.rejects(() => transport.execute(command('command-cancelled')), error => error === denied);
    assert.equal((await outbox.listRecoverable()).length, 0);
    assert.deepEqual(await transport.recoverPending(), []);
    assert.equal(reads, 0); assert.equal(submissions, 0);
  } finally { outbox.close(); }
});

test("decision and query attestation builders satisfy the wire contract and survive a JSON round-trip", () => {
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" } as const;
  const cmd = command("cmd-shape");
  for (const phase of ["proposal", "submit"] as const) {
    const built = decisionAttestation(actor, cmd, phase, "tx-shape");
    // Builder output must already satisfy the client-side contract the remote
    // signer enforces before opening a socket.
    assert.deepEqual(assertSigningAttestation(built), built);
    // The digest binds the command as the outbox records it; a JSON
    // round-trip of the input must not change it.
    assert.equal(built.command_digest, idempotencyDigest({ type: cmd.type, input: JSON.parse(JSON.stringify(cmd.input)) }));
  }
  assert.deepEqual(assertSigningAttestation(queryAttestation(actor)), queryAttestation(actor));
});

test("official SDK adapter sends Execute JSON without transport-only actor metadata", async () => {
  let seen: { name: string; argument: string } | undefined;
  const fakeContract = {
    newProposal(name: string, options: { arguments: string[] }) {
      seen = { name, argument: options.arguments[0] };
      return { getTransactionId: () => "tx-official", async endorse() { return { async submit() { return { async getStatus() { return { code: 0 }; } }; } }; } };
    },
    async evaluateTransaction() { return new Uint8Array(); },
  };
  const client = await connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl", credentials: {
      msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer: async (digest) => digest,
    },
    module: { connect() { return { getNetwork() { return { getContract() { return fakeContract; } }; } }; } },
  });
  await client.newProposal(command("cmd-official"));
  assert.equal(seen?.name, "Execute");
  assert.deepEqual(JSON.parse(seen?.argument ?? "{}"), { command_id: "cmd-official", type: "fence", input: { nonce: "cmd-official" } });
});

test("official gateway refreshes the signing attestation at each signing phase", async () => {
  const context: SigningAttestationContext = {};
  const built: Array<{ phase: string; txId: string | undefined }> = [];
  const signed: Array<Attestation | undefined> = [];
  // The fake SDK invokes the signer inside each signing call, exactly where the
  // real SDK produces signatures; the signer consumes the slot once per
  // request exactly like the production attestationSlot.
  const take = attestationSlot(context);
  const signer = async (digest: Uint8Array) => { signed.push(take()); return digest; };
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" } as const;
  const fakeContract = {
    newProposal() {
      return { getTransactionId: () => "tx-attested", async endorse() { await signer(new Uint8Array(32)); return { async submit() { await signer(new Uint8Array(32)); return { async getStatus() { return { code: 0 }; } }; }, async getResult() { return new Uint8Array(); } }; } };
    },
    async evaluateTransaction() { return new Uint8Array(); },
  };
  const client = await connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl",
    credentials: { msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer },
    module: { connect() { return { getNetwork() { return { getContract() { return fakeContract; } }; } }; } },
    attestation: {
      context,
      build: (cmd, phase, txId) => { built.push({ phase, txId }); return decisionAttestation(actor, cmd, phase, txId); },
      buildQuery: () => queryAttestation(actor),
    },
  });
  const cmd = command("cmd-attested");
  const endorsement = await (await client.newProposal(cmd)).endorse();
  await endorsement.submit();
  // Attestation is installed only where the SDK actually signs: proposal
  // binding inside endorse(), submit binding inside submit().
  assert.deepEqual(built, [{ phase: "proposal", txId: "tx-attested" }, { phase: "submit", txId: "tx-attested" }]);
  // The signer's view at digest time proves each phase signed its own
  // attestation; the slot is empty again once both operations completed.
  assert.equal(signed.length, 2);
  assertSigningAttestation(signed[0]);
  assertSigningAttestation(signed[1]);
  const [proposal, submit] = signed as [SigningAttestation, SigningAttestation];
  assert.equal(proposal.phase, "proposal");
  assert.equal(proposal.tx_id, "tx-attested");
  assert.equal(submit.phase, "submit");
  assert.equal(submit.tx_id, "tx-attested");
  assert.equal(submit.actor_id, "person-sales-owner");
  assert.equal(submit.command_digest, idempotencyDigest(cmd));
  assert.equal(context.current, undefined);
});

/** A query attestation must carry exactly the read-only shape — no command binding or tx_id may leak in. */
function assertQueryShape(attestation: Attestation | undefined): void {
  assert.ok(attestation !== undefined && attestation.phase === "query", "expected a query attestation");
  assert.deepEqual(Object.keys(attestation).sort(), ["actor_id", "actor_kind", "org_id", "phase"]);
}

test("read-only signing paths install a query attestation instead of a stale command context", async () => {
  const context: SigningAttestationContext = {};
  const signed: Array<Attestation | undefined> = [];
  const take = attestationSlot(context);
  const signer = async (digest: Uint8Array) => { signed.push(take()); return digest; };
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" } as const;
  const commit = { getBytes: () => new Uint8Array([1]), getTransactionId: () => "tx-query", async getStatus() { await signer(new Uint8Array(32)); return { code: 0, blockNumber: 7n }; } };
  const fakeContract = {
    newProposal() { return { getTransactionId: () => "tx-query", async endorse() { await signer(new Uint8Array(32)); return { async submit() { await signer(new Uint8Array(32)); return commit; }, async getResult() { return new Uint8Array(); } }; } }; },
    async evaluateTransaction(name: string) { await signer(new Uint8Array(32)); return name === "GetCommand" ? new TextEncoder().encode(JSON.stringify({ record_type: "IdempotencyRecord", command_id: "cmd-query", command_digest: "sha256:x", result: {} })) : new Uint8Array(); },
  };
  const client = await connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl",
    credentials: { msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer },
    module: { connect() { return { newCommit: () => commit, getNetwork() { return { getContract() { return fakeContract; } }; } }; } },
    attestation: {
      context,
      build: (cmd, phase, txId) => decisionAttestation(actor, cmd, phase, txId),
      buildQuery: () => queryAttestation(actor),
    },
  });
  const endorsement = await (await client.newProposal(command("cmd-query"))).endorse();
  await endorsement.submit();
  // Commit status and authoritative lookups must not reuse the write context.
  const status = await client.getStatus("tx-query");
  assert.equal(status.status, "VALID");
  const result = await client.getAuthoritativeCommandResult({ command_id: "cmd-query", actor_org_id: "SalesMSP" });
  assert.equal(result?.payload_digest, "sha256:x");
  assert.deepEqual(signed.map(entry => entry?.phase), ["proposal", "submit", "query", "query"]);
  // Read-only signatures carry the exact query shape, never a reused decision.
  assertQueryShape(signed[2]);
  assertQueryShape(signed[3]);
  assert.equal(context.current, undefined);
  client.close();
  assert.equal(context.current, undefined);
  // Closing the connection also releases the serializer claim: a reconnect
  // may claim the same context object instead of hitting 'already claimed'.
  const reclaimed = createAttestationSerializer(context);
  releaseAttestationSerializer(context, reclaimed);
});

test("official gateway rejects attestation builder output that mismatches the signed operation", async () => {
  const context: SigningAttestationContext = {};
  let signCalls = 0;
  const signer = async (digest: Uint8Array) => { signCalls += 1; return digest; };
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" } as const;
  const commit = { getBytes: () => new Uint8Array([1]), getTransactionId: () => "tx-built", async getStatus() { await signer(new Uint8Array(32)); return { code: 0 }; } };
  const fakeContract = {
    newProposal() { return { getTransactionId: () => "tx-built", async endorse() { await signer(new Uint8Array(32)); return { async submit() { return commit; }, async getResult() { return new Uint8Array(); } }; } }; },
    async evaluateTransaction() { await signer(new Uint8Array(32)); return new Uint8Array(); },
  };
  const connect = (attestation: Pick<GatewayAttestation, "build" | "buildQuery">) => connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl",
    credentials: { msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer },
    module: { connect() { return { newCommit: () => commit, getNetwork() { return { getContract() { return fakeContract; } }; } }; } },
    attestation: { context, ...attestation },
  });
  const cmd = command("cmd-built");
  const mismatched = [
    // A query-shaped attestation must never be attached to a write.
    () => queryAttestation(actor),
    // Claims bound to a different command or transaction are refused.
    () => decisionAttestation(actor, { command_id: "cmd-other", type: cmd.type, input: cmd.input }, "proposal", "tx-built"),
    () => decisionAttestation(actor, cmd, "proposal", "tx-other"),
    () => decisionAttestation(actor, cmd, "submit", "tx-built"),
    // Same command identity with a forged digest is refused on the recomputed
    // digest check, not merely on id/phase comparison.
    () => ({ ...decisionAttestation(actor, cmd, "proposal", "tx-built"), command_digest: "sha256:" + "0".repeat(64) }),
  ];
  for (const build of mismatched) {
    const client = await connect({ build: build as unknown as GatewayAttestation["build"], buildQuery: () => queryAttestation(actor) });
    const proposal = await client.newProposal(cmd);
    await assert.rejects(() => proposal.endorse(), /do not match the signed operation/);
    client.close();
  }
  assert.equal(signCalls, 0);
  // A configured builder that produces no attestation is a wiring bug: the
  // write must not proceed unattested.
  const emptyClient = await connect({ build: (() => undefined) as unknown as GatewayAttestation["build"], buildQuery: (() => undefined) as unknown as GatewayAttestation["buildQuery"] });
  const emptyProposal = await emptyClient.newProposal(cmd);
  await assert.rejects(() => emptyProposal.endorse(), /produced no evidence/);
  await assert.rejects(() => emptyClient.getStatus("tx-built", new Uint8Array([1])), /produced no evidence/);
  emptyClient.close();
  assert.equal(signCalls, 0);
  // The same contract applies to read-only builders: a decision-shaped output
  // for a query is refused before any signing call.
  const queryClient = await connect({ build: () => decisionAttestation(actor, cmd, "proposal", "tx-built"), buildQuery: (() => decisionAttestation(actor, cmd, "proposal", "tx-built")) as unknown as GatewayAttestation["buildQuery"] });
  await assert.rejects(() => queryClient.getStatus("tx-built", new Uint8Array([1])), /decision attestation for a read-only operation/);
  queryClient.close();
  assert.equal(signCalls, 0);
});

test("a concurrent status lookup cannot steal an in-flight decision attestation", async () => {
  const context: SigningAttestationContext = {};
  const signed: Array<Attestation | undefined> = [];
  const signedPhases = () => signed.map(entry => entry?.phase);
  let releaseEndorseSign: (() => void) | undefined;
  let endorseSignStarted: (() => void) | undefined;
  const endorseGate = new Promise<void>(resolve => { releaseEndorseSign = resolve; });
  const endorseSignSeen = new Promise<void>(resolve => { endorseSignStarted = resolve; });
  const take = attestationSlot(context);
  const signer = async (digest: Uint8Array) => {
    const attestation = take();
    signed.push(attestation);
    if (attestation?.phase === "proposal") { endorseSignStarted?.(); await endorseGate; }
    return digest;
  };
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" } as const;
  // Deterministic entry signals prove neither read entered its SDK call while
  // the decision signature was in-flight — a single microtask yield alone
  // could pass under a non-serialising implementation.
  const entered: string[] = [];
  const commit = { getBytes: () => new Uint8Array([1]), getTransactionId: () => "tx-race", async getStatus() { entered.push("status"); await signer(new Uint8Array(32)); return { code: 0 }; } };
  const fakeContract = {
    newProposal() { return { getTransactionId: () => "tx-race", async endorse() { await signer(new Uint8Array(32)); return { async submit() { return commit; }, async getResult() { return new Uint8Array(); } }; } }; },
    async evaluateTransaction(name: string) { entered.push("evaluate"); await signer(new Uint8Array(32)); return name === "GetCommand" ? new TextEncoder().encode(JSON.stringify({ record_type: "IdempotencyRecord", command_id: "cmd-race", command_digest: "sha256:x", result: {} })) : new Uint8Array(); },
  };
  const client = await connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl",
    credentials: { msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer },
    module: { connect() { return { newCommit: () => commit, getNetwork() { return { getContract() { return fakeContract; } }; } }; } },
    attestation: {
      context,
      build: (cmd, phase, txId) => decisionAttestation(actor, cmd, phase, txId),
      buildQuery: () => queryAttestation(actor),
    },
  });
  const proposal = await client.newProposal(command("cmd-race"));
  const endorsePromise = proposal.endorse();
  await endorseSignSeen;
  // The proposal signature is in-flight and has consumed its attestation;
  // neither read may enter the critical section: a started query would have
  // installed phase "query" or signed already, so both stay empty.
  const statusPromise = client.getStatus("tx-race", new Uint8Array([1]));
  const resultPromise = client.getAuthoritativeCommandResult({ command_id: "cmd-race", actor_org_id: "SalesMSP" });
  // A macrotask boundary flushes every queued microtask, so a competing read
  // that would enter its SDK call has had every chance to do so.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(signedPhases(), ["proposal"]);
  assert.deepEqual(entered, []);
  assert.equal(context.current, undefined);
  releaseEndorseSign?.();
  await endorsePromise;
  const status = await statusPromise;
  assert.equal(status.status, "VALID");
  assert.equal((await resultPromise)?.payload_digest, "sha256:x");
  assert.deepEqual(signedPhases(), ["proposal", "query", "query"]);
  // Queued reads signed under the exact query shape, not the stolen decision.
  assertQueryShape(signed[1]);
  assertQueryShape(signed[2]);
  assert.equal(context.current, undefined);
});

test("a concurrent status lookup cannot steal an in-flight submit attestation", async () => {
  const context: SigningAttestationContext = {};
  const signed: Array<Attestation | undefined> = [];
  const signedPhases = () => signed.map(entry => entry?.phase);
  let releaseSubmitSign: (() => void) | undefined;
  let submitSignStarted: (() => void) | undefined;
  const submitGate = new Promise<void>(resolve => { releaseSubmitSign = resolve; });
  const submitSignSeen = new Promise<void>(resolve => { submitSignStarted = resolve; });
  const take = attestationSlot(context);
  const signer = async (digest: Uint8Array) => {
    const attestation = take();
    signed.push(attestation);
    if (attestation?.phase === "submit") { submitSignStarted?.(); await submitGate; }
    return digest;
  };
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" } as const;
  const entered: string[] = [];
  const commit = { getBytes: () => new Uint8Array([1]), getTransactionId: () => "tx-submit-race", async getStatus() { entered.push("status"); await signer(new Uint8Array(32)); return { code: 0 }; } };
  const fakeContract = {
    newProposal() { return { getTransactionId: () => "tx-submit-race", async endorse() { await signer(new Uint8Array(32)); return { async submit() { await signer(new Uint8Array(32)); return commit; }, async getResult() { return new Uint8Array(); } }; } }; },
    async evaluateTransaction() { entered.push("evaluate"); await signer(new Uint8Array(32)); return new Uint8Array(); },
  };
  const client = await connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl",
    credentials: { msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer },
    module: { connect() { return { newCommit: () => commit, getNetwork() { return { getContract() { return fakeContract; } }; } }; } },
    attestation: {
      context,
      build: (cmd, phase, txId) => decisionAttestation(actor, cmd, phase, txId),
      buildQuery: () => queryAttestation(actor),
    },
  });
  const endorsement = await (await client.newProposal(command("cmd-submit-race"))).endorse();
  const submitPromise = endorsement.submit();
  await submitSignSeen;
  // The submit signature is in-flight; the read must queue behind it.
  const statusPromise = client.getStatus("tx-submit-race", new Uint8Array([1]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(signedPhases(), ["proposal", "submit"]);
  assert.deepEqual(entered, []);
  releaseSubmitSign?.();
  await submitPromise;
  const status = await statusPromise;
  assert.equal(status.status, "VALID");
  assert.deepEqual(signedPhases(), ["proposal", "submit", "query"]);
  assertQueryShape(signed[2]);
  assert.equal(context.current, undefined);
});

test("concurrent commands sign only their own decision attestation", async () => {
  const context: SigningAttestationContext = {};
  const signed: Array<SigningAttestation | undefined> = [];
  const take = attestationSlot(context);
  const signer = async (digest: Uint8Array) => { signed.push(take() as SigningAttestation | undefined); return digest; };
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" } as const;
  const fakeContract = {
    newProposal(id: string) { return { getTransactionId: () => `tx-${id}`, async endorse() { await signer(new Uint8Array(32)); return { async submit() { await signer(new Uint8Array(32)); return { async getStatus() { return { code: 0 }; } }; }, async getResult() { return new Uint8Array(); } }; } }; },
    async evaluateTransaction() { return new Uint8Array(); },
  };
  let nextId = 0;
  const client = await connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl",
    credentials: { msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer },
    module: { connect() { return { getNetwork() { return { getContract() { return { newProposal: () => fakeContract.newProposal(`cmd-${++nextId}`), evaluateTransaction: fakeContract.evaluateTransaction }; } }; } }; } },
    attestation: {
      context,
      build: (cmd, phase, txId) => decisionAttestation(actor, cmd, phase, txId),
      buildQuery: () => queryAttestation(actor),
    },
  });
  // Two commands endorsed concurrently on one connection: each signature must
  // carry the attestation of its own command and transaction, never the
  // sibling's.
  const [cmdA, cmdB] = [command("cmd-a"), command("cmd-b")];
  await Promise.all([
    (await client.newProposal(cmdA)).endorse().then(e => e.submit()),
    (await client.newProposal(cmdB)).endorse().then(e => e.submit()),
  ]);
  assert.equal(signed.length, 4);
  // Count attestations per command first: a clobbered slot would replay one
  // command's evidence twice and starve the sibling, which a per-entry shape
  // check alone cannot detect.
  assert.deepEqual(signed.map(attestation => attestation?.command_id).sort(), ["cmd-a", "cmd-a", "cmd-b", "cmd-b"]);
  const digestFor = (cmd: GatewayCommand) => idempotencyDigest(cmd);
  for (const attestation of signed) {
    assert.ok(attestation !== undefined);
    const cmd = attestation.command_id === "cmd-a" ? cmdA : cmdB;
    assert.equal(attestation.command_digest, digestFor(cmd));
    assert.equal(attestation.tx_id, `tx-cmd-${attestation.command_id === "cmd-a" ? 1 : 2}`);
  }
  assert.equal(context.current, undefined);
});

test("a failed operation clears its installed attestation before the next sign", async () => {
  const context: SigningAttestationContext = {};
  const signed: Array<Attestation | undefined> = [];
  const take = attestationSlot(context);
  const signer = async (digest: Uint8Array) => { signed.push(take()); return digest; };
  const actor = { org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" } as const;
  const commit = { getBytes: () => new Uint8Array([1]), getTransactionId: () => "tx-fail", async getStatus() { await signer(new Uint8Array(32)); return { code: 0 }; } };
  const fakeContract = {
    // endorse() rejects before the SDK ever reaches the signer, leaving the
    // installed proposal attestation unconsumed inside the operation.
    newProposal() { return { getTransactionId: () => "tx-fail", async endorse() { throw new Error("endorse failed"); } }; },
    async evaluateTransaction() { return new Uint8Array(); },
  };
  const client = await connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl",
    credentials: { msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer },
    module: { connect() { return { newCommit: () => commit, getNetwork() { return { getContract() { return fakeContract; } }; } }; } },
    attestation: {
      context,
      build: (cmd, phase, txId) => decisionAttestation(actor, cmd, phase, txId),
      buildQuery: () => queryAttestation(actor),
    },
  });
  await assert.rejects((await client.newProposal(command("cmd-fail"))).endorse(), /endorse failed/);
  // The unconsumed proposal attestation was rolled back: the next signing call
  // sees only its own query attestation, not the stale decision.
  assert.equal(context.current, undefined);
  await client.getStatus("tx-fail", new Uint8Array([1]));
  assert.deepEqual(signed.map(entry => (entry as { phase?: string } | undefined)?.phase), ["query"]);
  assert.equal(context.current, undefined);
});

test("SQLite outbox persists recoverable attempts", async () => {
  const outbox = new SqliteOutbox(":memory:");
  await outbox.recordAttempt({ command_id: "cmd-sqlite", actor_org_id: "SalesMSP", payload_digest: "sha256:abc", tx_id: "tx-sqlite", status: "unknown" });
  const attempts = await outbox.listRecoverable();
  assert.equal(attempts[0]?.tx_id, "tx-sqlite");
  await outbox.updateAttempt("tx-sqlite", { status: "valid" });
  assert.equal((await outbox.listRecoverable()).length, 0);
  outbox.close();
});

test('restart recovery forwards persisted commit bytes to the SDK status lookup', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-outbox-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'outbox.sqlite');
  let outbox = new SqliteOutbox(path);
  const bytes = new Uint8Array([7, 8, 9]);
  await outbox.recordAttempt({ command_id: 'command-recover', actor_org_id: 'SalesMSP', payload_digest: 'sha256:recovery', tx_id: 'tx-recover', status: 'acknowledged', commit_bytes: bytes });
  outbox.close();
  outbox = new SqliteOutbox(path);
  try {
    const client: FabricGatewayClient = {
      async newProposal() { throw new Error('recovery must not resubmit'); },
      async getStatus(id, persisted) { return id === 'tx-recover' && persisted?.[0] === 7 ? { status: 'VALID' } : { status: 'UNKNOWN' }; },
    };
    const results = await new FabricGatewayTransport({ client, outbox }).recoverPending();
    assert.equal(results[0].status, 'valid');
    assert.equal((await outbox.listRecoverable()).length, 0);
  } finally { outbox.close(); }
});

test('a lost status response can reconcile an already committed command', async () => {
  const cmd = command('command-status-lost');
  const client: FabricGatewayClient = {
    async newProposal() { return { tx_id: 'tx-status-lost', async endorse() { return { async submit() {} }; } }; },
    async getStatus() { throw new Error('peer status response lost'); },
    async getAuthoritativeCommandResult() { return { payload_digest: idempotencyDigest(cmd), result: { status: 'fenced' } }; },
  };
  const result = await new FabricGatewayTransport({ client, outbox: new FakeOutbox() }).execute(cmd);
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.result, { status: 'fenced' });
});

test('the official SDK wire result is decoded only after VALID into the domain result', async () => {
  const events: string[] = [];
  const bytes = new TextEncoder().encode(JSON.stringify({ status: 'executed', result: { status: 'fenced', nonce: 'nonce-test-long-value' } }));
  const commit = { getBytes: () => new Uint8Array([1]), getTransactionId: () => 'tx-decoded', async getStatus() { events.push('VALID'); return { code: 0, blockNumber: 123n }; } };
  const contract = {
    newProposal() { return { getTransactionId: () => 'tx-decoded', async endorse() { return { async submit() { return commit; }, getResult() { events.push('result'); return bytes; } }; } }; },
    async evaluateTransaction() { return new Uint8Array(); },
  };
  const client = await connectOfficialFabricGateway({ client: {}, channel_id: 'kcl-demo', chaincode_name: 'kcl', credentials: { msp_id: 'SalesMSP', certificate: new Uint8Array([1]), signer: async digest => digest },
    module: { connect() { return { newCommit: () => commit, getNetwork: () => ({ getContract: () => contract }) }; } },
  });
  const result = await new FabricGatewayTransport({ client, outbox: new FakeOutbox() }).execute(command('command-decoded'));
  assert.deepEqual(result.result, { status: 'fenced', nonce: 'nonce-test-long-value' });
  assert.deepEqual(events, ['VALID', 'result']);
});

test('command observation recovers status without resubmitting and keeps VALID pending for projection',async()=>{
  const outbox=new SqliteOutbox(':memory:');let writes=0;let status:'UNKNOWN'|'INVALID'|'VALID'='UNKNOWN';
  const cmd=command('command-observe');const digest=idempotencyDigest(cmd);
  await outbox.recordAttempt({command_id:cmd.command_id,actor_org_id:cmd.actor_org_id,payload_digest:digest,tx_id:'tx-observe',status:'unknown',commit_bytes:new Uint8Array([1])});
  const transport=new FabricGatewayTransport({outbox,client:{async newProposal(){writes++;throw new Error('Must not write');},async getStatus(){return {status};}}});
  try {
    assert.equal((await transport.observeCommand(cmd,true))?.status,'pending');
    status='VALID';assert.equal((await transport.observeCommand(cmd,true))?.status,'pending');assert.equal(writes,0);
    await outbox.recordAttempt({command_id:'command-reject',actor_org_id:cmd.actor_org_id,payload_digest:digest,tx_id:'tx-reject',status:'unknown'});
    status='INVALID';assert.equal((await transport.observeCommand({...cmd,command_id:'command-reject'},true))?.status,'rejected');
    await outbox.recordAttempt({command_id:'command-cancel',actor_org_id:cmd.actor_org_id,payload_digest:digest,tx_id:'tx-cancel',status:'cancelled'});
    assert.equal((await transport.observeCommand({...cmd,command_id:'command-cancel'},true))?.status,'cancelled');
    assert.equal(await transport.observeCommand({...cmd,actor_org_id:'OtherMSP'},true),undefined);assert.equal(writes,0);
  } finally {outbox.close();}
});
