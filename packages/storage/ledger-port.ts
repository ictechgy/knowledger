import type { Actor, Checkpoint, LedgerEvent } from './local-ledger.ts';
import type { DomainCommand } from '../domain/index.ts';
import type { BrowseQueryFunction } from './browse-contract.ts';

export interface CommittedReceipt {
  status: 'committed';
  result: any;
  checkpoint: Checkpoint;
}

export interface PendingReceipt {
  status: 'pending';
  command_id: string;
  tx_id: string;
  payload_digest: string;
}
export type CommandObservation = CommittedReceipt | { status: 'pending' | 'rejected' | 'cancelled'; code?: string };

/** Application reads use verified committed state; writes remain adapter-owned. */
export interface ApplicationLedger {
  readonly channelId: string;
  readonly mode: 'local-simulation' | 'fabric-test-network' | 'fabric';
  refresh(): Promise<void>;
  read(key: string, at?: Checkpoint | null): any | undefined;
  entries(prefix: string, at?: Checkpoint | null): [string, any][];
  /** Optional indexed metadata selection; canonical values still use read(). */
  queryBrowse?: BrowseQueryFunction;
  checkpoint(): Checkpoint | null;
  assertCheckpoint(at: Checkpoint): void;
  checkpointForTransaction(transactionId: string): Checkpoint;
  checkpointForStateCreation(key: string): Checkpoint;
  events(after?: number, limit?: number): LedgerEvent[];
  execute(actor: Actor, command: DomainCommand): Promise<CommittedReceipt | PendingReceipt>;
  observeCommand?(actor: Actor, command: DomainCommand, queryPeer: boolean): Promise<CommandObservation | undefined>;
  bootstrap?(actor: Actor, config: unknown): Promise<CommittedReceipt>;
  /** 운영 관측 스냅샷(어댑터별). 없으면 서버가 공통 정보만 보고한다. */
  operations?(): Promise<Record<string, unknown>>;
  close(): void | Promise<void>;
}
