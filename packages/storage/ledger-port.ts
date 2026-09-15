import type { Actor, Checkpoint, LedgerEvent } from './local-ledger.ts';
import type { DomainCommand } from '../domain/index.ts';

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

/** Application reads use verified committed state; writes remain adapter-owned. */
export interface ApplicationLedger {
  readonly channelId: string;
  readonly mode: 'local-simulation' | 'fabric-test-network';
  refresh(): Promise<void>;
  read(key: string, at?: Checkpoint | null): any | undefined;
  entries(prefix: string, at?: Checkpoint | null): [string, any][];
  checkpoint(): Checkpoint | null;
  assertCheckpoint(at: Checkpoint): void;
  checkpointForTransaction(transactionId: string): Checkpoint;
  checkpointForStateCreation(key: string): Checkpoint;
  events(after?: number, limit?: number): LedgerEvent[];
  execute(actor: Actor, command: DomainCommand): Promise<CommittedReceipt | PendingReceipt>;
  bootstrap?(actor: Actor, config: unknown): Promise<CommittedReceipt>;
  close(): void | Promise<void>;
}
