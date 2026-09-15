import { performance } from 'node:perf_hooks';
import { execute as validateCommand, idempotencyDigest, keyFor } from '../domain/index.ts';
import type { DomainCommand } from '../domain/index.ts';
import type { Actor, Checkpoint } from '../storage/local-ledger.ts';
import type { ApplicationLedger, CommittedReceipt, PendingReceipt } from '../storage/ledger-port.ts';
import type { SqliteFabricProjection } from './sqlite-projection.ts';
import type { FabricGatewayTransport } from './gateway.ts';

export interface PeerBlockSource {
  getTip(): Promise<{ height: number; block_hash: string }>;
  getBlock(number: number): Promise<Uint8Array>;
  close?(): void | Promise<void>;
}

export interface FabricSigningRoute {
  actor: Actor;
  transport: Pick<FabricGatewayTransport, 'execute' | 'recoverPending'>;
  close?(): void | Promise<void>;
}

export class FabricLedgerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, status = 503, retryable = true) { super(message); this.code = code; this.status = status; this.retryable = retryable; }
}

type Projection = Pick<SqliteFabricProjection, 'channelId' | 'applyBlock' | 'blockCheckpoint' | 'read' | 'entries' | 'checkpoint' | 'checkpointForTransaction' | 'checkpointForStateCreation' | 'assertCheckpoint' | 'events' | 'close'>;
const sameActor = (a: Actor, b: Actor) => a.org_id === b.org_id && a.actor_id === b.actor_id && a.kind === b.kind;
function isActor(value: unknown): value is Actor {
  return !!value && typeof value === 'object' && 'org_id' in value && typeof value.org_id === 'string'
    && 'actor_id' in value && typeof value.actor_id === 'string' && 'kind' in value && (value.kind === 'human' || value.kind === 'agent');
}

/** Commands cross the real Gateway; all returned state comes from full peer blocks. */
export class FabricApplicationLedger implements ApplicationLedger {
  readonly mode: 'fabric-test-network' | 'fabric';
  readonly channelId: string;
  private queue: Promise<unknown> = Promise.resolve();
  private available = false;
  private closed = false;
  private readonly routes: FabricSigningRoute[];
  private readonly options: { projection: Projection; source: PeerBlockSource; routes: FabricSigningRoute[]; catchupTimeoutMs?: number };

  constructor(options: { projection: Projection; source: PeerBlockSource; routes: FabricSigningRoute[]; catchupTimeoutMs?: number; mode?: 'fabric-test-network' | 'fabric' }) {
    this.mode = options.mode ?? 'fabric-test-network';
    this.options = options;
    this.channelId = options.projection.channelId;
    if (options.catchupTimeoutMs !== undefined && (!Number.isSafeInteger(options.catchupTimeoutMs) || options.catchupTimeoutMs <= 0)) throw new Error('Catch-up timeout must be positive integer milliseconds');
    this.routes = options.routes.map(route => ({ ...route, actor: { ...route.actor } }));
    if (!this.routes.length || new Set(this.routes.map(route => JSON.stringify(route.actor))).size !== this.routes.length) throw new Error('Distinct authenticated Fabric signing routes are required');
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new FabricLedgerError('LEDGER_CLOSED', '원장 연결이 종료되었습니다.'));
    const operation = this.queue.then(run);
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async synchronize(): Promise<void> {
    try { await this.catchUp(); this.available = true; }
    catch (error) { this.available = false; throw error; }
  }

  private async catchUp(): Promise<void> {
    const started = performance.now();
    let tip: { height: number; block_hash: string };
    try { tip = await this.options.source.getTip(); }
    catch { throw new FabricLedgerError('FRESHNESS_UNAVAILABLE', '신뢰하는 peer의 최신 원장 상태를 확인하지 못했습니다.'); }
    const previous = this.options.projection.blockCheckpoint();
    if (!Number.isSafeInteger(tip.height) || tip.height < 1 || !/^[a-f0-9]{64}$/.test(tip.block_hash) || tip.height < (previous?.block_number ?? -1) + 1) {
      throw new FabricLedgerError('PROJECTION_BEHIND', 'peer가 저장된 체크포인트보다 뒤처졌거나 올바른 상태를 반환하지 않았습니다.');
    }
    for (let number = (previous?.block_number ?? -1) + 1; number < tip.height; number++) {
      if (performance.now() - started > (this.options.catchupTimeoutMs ?? 5000)) throw new FabricLedgerError('PROJECTION_BEHIND', '블록 반영 대기 시간을 초과했습니다.');
      let bytes: Uint8Array;
      try { bytes = await this.options.source.getBlock(number); }
      catch { throw new FabricLedgerError('PROJECTION_BEHIND', 'peer의 전체 블록을 가져오지 못했습니다.'); }
      try { this.options.projection.applyBlock(bytes); }
      catch { throw new FabricLedgerError('PROJECTION_INVALID', '블록 검증에 실패해 상태 반영을 중단했습니다.', 503, false); }
    }
    const current = this.options.projection.blockCheckpoint();
    if (current?.block_number !== tip.height - 1 || current?.block_hash !== tip.block_hash) throw new FabricLedgerError('PROJECTION_INVALID', '저장된 원장과 peer의 블록 해시가 일치하지 않습니다.', 503, false);
    if (performance.now() - started > (this.options.catchupTimeoutMs ?? 5000)) throw new FabricLedgerError('PROJECTION_BEHIND', '블록 반영 대기 시간을 초과했습니다.');
  }

  refresh(): Promise<void> { return this.serial(() => this.synchronize()); }

  private ready(): void {
    if (this.closed || !this.available) throw new FabricLedgerError('FRESHNESS_UNAVAILABLE', '최신 peer 상태를 확인한 뒤 다시 시도해 주세요.');
  }
  read(key: string, at?: Checkpoint | null): any { this.ready(); return this.options.projection.read(key, at); }
  entries(prefix: string, at?: Checkpoint | null): [string, any][] { this.ready(); return this.options.projection.entries(prefix, at); }
  checkpoint() { this.ready(); return this.options.projection.checkpoint(); }
  checkpointForTransaction(id: string) { this.ready(); return this.options.projection.checkpointForTransaction(id); }
  checkpointForStateCreation(key: string) { this.ready(); return this.options.projection.checkpointForStateCreation(key); }
  assertCheckpoint(at: Checkpoint) { this.ready(); this.options.projection.assertCheckpoint(at); }
  events(after = 0, limit = 100) { this.ready(); return this.options.projection.events(after, limit); }

  private committed(actor: Actor, command: DomainCommand): CommittedReceipt | undefined {
    const record = this.options.projection.read(keyFor.idempotency(actor.org_id, command.command_id));
    if (!record) return undefined;
    if (typeof record !== 'object' || !('actor' in record) || !isActor(record.actor)
      || !('command_digest' in record) || !('command_type' in record) || !('result' in record)
      || !('tx_id' in record) || typeof record.tx_id !== 'string') throw new FabricLedgerError('PROJECTION_INVALID', '검증된 명령 기록의 구조가 올바르지 않습니다.', 503, false);
    if (!sameActor(record.actor, actor) || record.command_digest !== idempotencyDigest(command) || record.command_type !== command.type) throw new FabricLedgerError('IDEMPOTENCY_CONFLICT', '같은 command_id가 다른 사용자 또는 요청에 사용되었습니다.', 409, false);
    return { status: 'committed', result: record.result, checkpoint: this.options.projection.checkpointForTransaction(record.tx_id) };
  }

  execute(actor: Actor, command: DomainCommand): Promise<CommittedReceipt | PendingReceipt> {
    return this.serial(async () => {
      const route = this.routes.find(route => sameActor(route.actor, actor));
      if (!route) throw new FabricLedgerError('SIGNER_FORBIDDEN', '인증된 서명 신원이 없는 사용자입니다.', 403, false);
      await this.synchronize();
      const prior = this.committed(actor, command);
      if (prior) return prior;
      // Preflight protects publication boundaries and provides domain errors.
      // Only the chaincode execution and subsequent VALID peer block are authoritative.
      const staged = new Map<string, unknown>();
      await validateCommand({ actor, channel_id: this.channelId, tx_id: 'preflight', timestamp: new Date().toISOString(),
        get: async key => staged.has(key) ? structuredClone(staged.get(key)) : this.options.projection.read(key),
        put: async (key, value) => { staged.set(key, structuredClone(value)); },
      }, command);
      const submitted = await route.transport.execute({ ...command, actor_org_id: actor.org_id });
      const pending: PendingReceipt = { status: 'pending', command_id: command.command_id, tx_id: submitted.tx_id, payload_digest: submitted.payload_digest };
      if (submitted.status === 'invalid') throw new FabricLedgerError('LEDGER_CONFLICT', '거래가 VALID로 커밋되지 않았습니다. 최신 상태를 확인해 주세요.', 409);
      try { await this.synchronize(); }
      catch (error) {
        if (error instanceof FabricLedgerError && error.code === 'PROJECTION_INVALID') throw error;
        return pending;
      }
      return this.committed(actor, command) ?? pending;
    });
  }

  recoverPending(): Promise<void> {
    return this.serial(async () => {
      for (const route of this.routes) await route.transport.recoverPending();
      await this.synchronize();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    try { for (const route of this.routes) await route.close?.(); }
    finally { try { await this.options.source.close?.(); } finally { this.options.projection.close(); } }
  }
}
