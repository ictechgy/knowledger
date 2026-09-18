import test from "node:test";
import assert from "node:assert/strict";
import { idempotencyDigest } from "../../packages/domain/index.ts";
import { decisionAttestation, FabricGatewayTransport, connectOfficialFabricGateway } from "../../packages/fabric/gateway.ts";
import { assertSigningAttestation, type SigningAttestation, type SigningAttestationContext } from "../../packages/fabric/remote-signer.ts";
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
  const signed: Array<SigningAttestation | undefined> = [];
  // The fake SDK invokes the signer inside each signing call, exactly where the
  // real SDK produces signatures.
  const signer = async (digest: Uint8Array) => { signed.push(context.current as SigningAttestation | undefined); return digest; };
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
      build: (cmd, phase, txId) => { built.push({ phase, txId }); return decisionAttestation({ org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" }, cmd, phase, txId); },
      buildQuery: () => ({ org_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human", phase: "query" }),
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
  assert.equal(signed[0]?.phase, "proposal");
  assert.equal(signed[0]?.tx_id, "tx-attested");
  assert.equal(signed[1]?.phase, "submit");
  assert.equal(signed[1]?.tx_id, "tx-attested");
  assert.equal(signed[1]?.actor_id, "person-sales-owner");
  assert.equal(signed[1]?.command_digest, idempotencyDigest(cmd));
  assert.equal(context.current, undefined);
});

test("read-only signing paths install a query attestation instead of a stale command context", async () => {
  const context: SigningAttestationContext = {};
  const signed: Array<SigningAttestation | { phase: string } | undefined> = [];
  const signer = async (digest: Uint8Array) => { signed.push(context.current as SigningAttestation | undefined); return digest; };
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
      build: (cmd, phase, txId) => decisionAttestation({ org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" }, cmd, phase, txId),
      buildQuery: () => ({ org_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human", phase: "query" }),
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
  assert.equal(context.current, undefined);
  client.close();
  assert.equal(context.current, undefined);
});

test("a concurrent status lookup cannot steal an in-flight decision attestation", async () => {
  const context: SigningAttestationContext = {};
  const signedPhases: Array<string | undefined> = [];
  let releaseEndorseSign: (() => void) | undefined;
  let endorseSignStarted: (() => void) | undefined;
  const endorseGate = new Promise<void>(resolve => { releaseEndorseSign = resolve; });
  const endorseSignSeen = new Promise<void>(resolve => { endorseSignStarted = resolve; });
  const signer = async (digest: Uint8Array) => {
    const attestation = context.current as { phase?: string } | undefined;
    signedPhases.push(attestation?.phase);
    if (attestation?.phase === "proposal") { endorseSignStarted?.(); await endorseGate; }
    return digest;
  };
  const commit = { getBytes: () => new Uint8Array([1]), getTransactionId: () => "tx-race", async getStatus() { await signer(new Uint8Array(32)); return { code: 0 }; } };
  const fakeContract = {
    newProposal() { return { getTransactionId: () => "tx-race", async endorse() { await signer(new Uint8Array(32)); return { async submit() { return commit; }, async getResult() { return new Uint8Array(); } }; } }; },
    async evaluateTransaction() { return new Uint8Array(); },
  };
  const client = await connectOfficialFabricGateway({
    client: {}, channel_id: "kcl-demo", chaincode_name: "kcl",
    credentials: { msp_id: "SalesMSP", certificate: new Uint8Array([1]), signer },
    module: { connect() { return { newCommit: () => commit, getNetwork() { return { getContract() { return fakeContract; } }; } }; } },
    attestation: {
      context,
      build: (cmd, phase, txId) => decisionAttestation({ org_id: "SalesMSP", actor_id: "person-sales-owner", kind: "human" }, cmd, phase, txId),
      buildQuery: () => ({ org_id: "SalesMSP", actor_id: "person-sales-owner", actor_kind: "human", phase: "query" }),
    },
  });
  const proposal = await client.newProposal(command("cmd-race"));
  const endorsePromise = proposal.endorse();
  await endorseSignSeen;
  // The proposal signature is in-flight with its attestation installed; the
  // status lookup must queue behind it rather than overwrite the slot.
  const statusPromise = client.getStatus("tx-race", new Uint8Array([1]));
  await Promise.resolve();
  assert.deepEqual(signedPhases, ["proposal"]);
  releaseEndorseSign?.();
  await endorsePromise;
  const status = await statusPromise;
  assert.equal(status.status, "VALID");
  assert.deepEqual(signedPhases, ["proposal", "query"]);
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
