import test from "node:test";
import assert from "node:assert/strict";
import { idempotencyDigest } from "../../packages/domain/index.ts";
import { FabricGatewayTransport, connectOfficialFabricGateway } from "../../packages/fabric/gateway.ts";
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
  const directory = mkdtempSync(join(tmpdir(), 'kcl-outbox-test-'));
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
