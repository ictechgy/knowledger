import { performance } from 'node:perf_hooks';
import { execute as validateCommand, idempotencyDigest, keyFor } from '../domain/index.ts';
import type { DomainCommand } from '../domain/index.ts';
import type { Actor, Checkpoint } from '../storage/local-ledger.ts';
import type { ApplicationLedger, CommittedReceipt, PendingReceipt, CommandObservation } from '../storage/ledger-port.ts';
import type { BrowseQuery, BrowseQueryFunction } from '../storage/browse-contract.ts';
import type { SqliteFabricProjection } from './sqlite-projection.ts';
import type { FabricGatewayTransport } from './gateway.ts';

export interface PeerBlockSource {
  getTip(): Promise<{ height: number; block_hash: string }>;
  getBlock(number: number): Promise<Uint8Array>;
  close?(): void | Promise<void>;
}

export interface FabricSigningRoute {
  actor: Actor;
  transport: Pick<FabricGatewayTransport, 'execute' | 'recoverPending'> & Partial<Pick<FabricGatewayTransport,'observeCommand'>>;
  close?(): void | Promise<void>;
}

export class FabricLedgerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, status = 503, retryable = true) { super(message); this.code = code; this.status = status; this.retryable = retryable; }
}

type Projection = Pick<SqliteFabricProjection, 'channelId' | 'applyBlock' | 'blockCheckpoint' | 'read' | 'entries' | 'checkpoint' | 'checkpointForTransaction' | 'checkpointForStateCreation' | 'assertCheckpoint' | 'events' | 'close'> & { queryBrowse?: BrowseQueryFunction };
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
  private projectionQueue: Promise<unknown> = Promise.resolve();
  private pendingCommands = 0;
  private refreshGeneration = 0;
  private refreshInFlight: { generation: number; promise: Promise<void> } | undefined;
  private available = false;
  private closed = false;
  private readonly routes: FabricSigningRoute[];
  private readonly maxPendingCommands: number;
  private readonly options: { projection: Projection; source: PeerBlockSource; routes: FabricSigningRoute[]; catchupTimeoutMs?: number; maxPendingCommands?: number; refreshTimeoutMs?: number };
  /** Optional so lightweight projection fixtures can use the explicit service scanner. */
  queryBrowse?: BrowseQueryFunction;

  constructor(options: { projection: Projection; source: PeerBlockSource; routes: FabricSigningRoute[]; catchupTimeoutMs?: number; maxPendingCommands?: number; mode?: 'fabric-test-network' | 'fabric'; refreshTimeoutMs?: number }) {
    this.mode = options.mode ?? 'fabric-test-network';
    this.options = options;
    this.channelId = options.projection.channelId;
    if (options.catchupTimeoutMs !== undefined && (!Number.isSafeInteger(options.catchupTimeoutMs) || options.catchupTimeoutMs <= 0)) throw new Error('Catch-up timeout must be positive integer milliseconds');
    if (options.refreshTimeoutMs !== undefined && (!Number.isSafeInteger(options.refreshTimeoutMs) || options.refreshTimeoutMs <= 0)) throw new Error('Refresh timeout must be positive integer milliseconds');
    this.maxPendingCommands = options.maxPendingCommands ?? 64;
    if (!Number.isSafeInteger(this.maxPendingCommands) || this.maxPendingCommands <= 0) throw new Error('Maximum pending command count must be positive integer');
    this.routes = options.routes.map(route => ({ ...route, actor: { ...route.actor } }));
    if (!this.routes.length || new Set(this.routes.map(route => JSON.stringify(route.actor))).size !== this.routes.length) throw new Error('Distinct authenticated Fabric signing routes are required');
    if (options.projection.queryBrowse) {
      this.queryBrowse = <Q extends BrowseQuery>(query: Q) => {
        this.ready();
        return options.projection.queryBrowse!(query);
      };
    }
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new FabricLedgerError('LEDGER_CLOSED', '원장 연결이 종료되었습니다.'));
    if (this.pendingCommands >= this.maxPendingCommands) return Promise.reject(new FabricLedgerError('LEDGER_BUSY', '원장 요청이 처리 중입니다. 잠시 후 다시 시도해 주세요.', 429));
    this.pendingCommands += 1;
    const operation = this.queue.then(run);
    this.queue = operation.catch(() => undefined);
    return operation.finally(() => { this.pendingCommands -= 1; });
  }

  /** Projection application is a single ordered writer, independent of external command transport. */
  private project<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.projectionQueue.then(run);
    this.projectionQueue = operation.catch(() => undefined);
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

  private refreshAt(generation: number): Promise<void> {
    const active = this.refreshInFlight;
    if (active && active.generation >= generation) return active.promise;
    const previous = active?.promise;
    const tracked: { generation: number; promise: Promise<void> } = { generation, promise: undefined! };
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      await this.project(() => this.synchronize());
    })();
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 멈춘 갱신이 readiness를 영구히 가리지 못하게 버리고, 그 작업이 점유한
        // 큐들도 해제해 다음 갱신·명령이 새로 시작될 수 있게 한다.
        this.available = false;
        if (this.refreshInFlight === tracked) this.refreshInFlight = undefined;
        this.projectionQueue = Promise.resolve();
        this.queue = Promise.resolve();
        reject(new FabricLedgerError('FRESHNESS_UNAVAILABLE', '원장 갱신이 시간 안에 끝나지 않았습니다.'));
      }, this.options.refreshTimeoutMs ?? 30_000);
      timer.unref();
      work.then(
        () => { clearTimeout(timer); resolve(); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
    tracked.promise = promise;
    this.refreshInFlight = tracked;
    void promise.finally(() => {
      if (this.refreshInFlight === tracked) this.refreshInFlight = undefined;
    }).catch(() => undefined);
    return promise;
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new FabricLedgerError('LEDGER_CLOSED', '원장 연결이 종료되었습니다.'));
    return this.refreshAt(this.refreshGeneration);
  }

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
      let prior: CommittedReceipt | undefined;
      await this.project(async () => {
        await this.synchronize();
        prior = this.committed(actor, command);
        if (prior) return;
        // Preflight protects publication boundaries and provides domain errors.
        // Only the chaincode execution and subsequent VALID peer block are authoritative.
        const staged = new Map<string, unknown>();
        await validateCommand({ actor, channel_id: this.channelId, tx_id: 'preflight', timestamp: new Date().toISOString(),
          get: async key => staged.has(key) ? structuredClone(staged.get(key)) : this.options.projection.read(key),
          put: async (key, value) => { staged.set(key, structuredClone(value)); },
        }, command);
      });
      if (prior) return prior;
      let submitted;
      let writeGeneration: number;
      try {
        // The command queue still protects route ordering, while the projection gate
        // is free to catch up during this external, potentially slow operation.
        submitted = await route.transport.execute({ ...command, actor_org_id: actor.org_id });
      } finally {
        // Any settled transport call may have reached the ordering service. Force a
        // refresh created after this call to wait for the latest peer tip.
        writeGeneration = ++this.refreshGeneration;
      }
      const pending: PendingReceipt = { status: 'pending', command_id: command.command_id, tx_id: submitted.tx_id, payload_digest: submitted.payload_digest };
      if (submitted.status === 'invalid') throw new FabricLedgerError('LEDGER_CONFLICT', '거래가 VALID로 커밋되지 않았습니다. 최신 상태를 확인해 주세요.', 409);
      try { await this.refreshAt(writeGeneration); }
      catch (error) {
        if (error instanceof FabricLedgerError && error.code === 'PROJECTION_INVALID') throw error;
        return pending;
      }
      return this.committed(actor, command) ?? pending;
    });
  }

  recoverPending(): Promise<void> {
    return this.serial(async () => {
      try {
        for (const route of this.routes) await route.transport.recoverPending();
      } finally {
        this.refreshGeneration += 1;
      }
      await this.refreshAt(this.refreshGeneration);
    });
  }

  observeCommand(actor: Actor, command: DomainCommand, queryPeer: boolean): Promise<CommandObservation|undefined> {
    return this.serial(async()=>{
      const route=this.routes.find(route=>sameActor(route.actor,actor));
      if(!route) throw new FabricLedgerError('SIGNER_FORBIDDEN','인증된 서명 신원이 없는 사용자입니다.',403,false);
      let prior: CommittedReceipt | undefined;
      await this.project(async () => {
        this.ready();
        prior=this.committed(actor,command);
      });
      if(prior)return prior;
      const observed=await route.transport.observeCommand?.({...command,actor_org_id:actor.org_id},queryPeer);
      if(queryPeer) {
        const generation=++this.refreshGeneration;
        await this.refreshAt(generation);
      }
      return this.project(async () => this.committed(actor,command) ?? observed);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.projectionQueue;
    const refresh = this.refreshInFlight?.promise;
    if (refresh) await refresh.catch(() => undefined);
    await this.projectionQueue;
    try { for (const route of this.routes) await route.close?.(); }
    finally { try { await this.options.source.close?.(); } finally { this.options.projection.close(); } }
  }
}
