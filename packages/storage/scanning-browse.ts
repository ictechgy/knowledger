import { VerifiedBrowseIndex } from './browse-index.ts';
import type { BrowseQuery, BrowseResult, BrowseWriteBatch } from './browse-contract.ts';
import type { ApplicationLedger } from './ledger-port.ts';

type Source = Pick<ApplicationLedger, 'channelId' | 'entries' | 'assertCheckpoint' | 'checkpointForStateCreation'>;

/** Compatibility path for adapters without queryBrowse, using their verified reads. */
export class ScanningBrowseQueries {
  private readonly ledger: Source;
  private snapshotKey: string | undefined;
  private index: VerifiedBrowseIndex | undefined;

  constructor(ledger: Source) { this.ledger = ledger; }

  query<Q extends BrowseQuery>(query: Q): BrowseResult<Q> {
    this.ledger.assertCheckpoint(query.at);
    const key = JSON.stringify(query.at);
    if (key !== this.snapshotKey || !this.index) {
      const index = new VerifiedBrowseIndex(this.ledger.channelId);
      const ledger = this.ledger;
      function* records(): Generator<BrowseWriteBatch> {
        for (const kind of ['revision', 'proposal', 'agreement']) {
          for (const [stateKey, value] of ledger.entries(`kcl:v1:${kind}:`, query.at)) {
            yield { checkpoint: ledger.checkpointForStateCreation(stateKey), writes: [[stateKey, value]] };
          }
        }
      }
      index.prepare(records()).commit();
      this.index = index; this.snapshotKey = key;
    }
    return this.index.query(query);
  }
}
