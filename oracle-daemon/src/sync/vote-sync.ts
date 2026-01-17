import { getDashCoreClient } from '../core/dash-core-client.js';
import { getPlatformPublisher } from '../core/platform-publisher.js';
import { createLogger } from '../utils/logger.js';
import { normalizeHash, bytesToHex } from '../utils/hash-utils.js';
import { SyncResult, VoteData } from '../types.js';

const logger = createLogger('VoteSync');

export class VoteSync {
  private dashCore = getDashCoreClient();
  private publisher = getPlatformPublisher();

  /**
   * Sync votes for all active proposals
   */
  async sync(): Promise<SyncResult> {
    const startTime = Date.now();
    let created = 0;
    let updated = 0;
    const deleted = 0;
    let errors = 0;

    try {
      logger.info('Starting vote sync');

      // Only sync votes for active proposals (optimization)
      const activeProposals = await this.publisher.getProposalsByStatus('active');
      logger.info('Syncing votes for active proposals', { count: activeProposals.length });

      for (const proposal of activeProposals) {
        try {
          const proposalData = proposal as unknown as { proposalHash?: number[] };
          if (!proposalData.proposalHash) continue;

          // Convert byte array to hex
          const proposalHash = bytesToHex(proposalData.proposalHash);

          const result = await this.syncVotesForProposal(proposalHash);
          created += result.created;
          updated += result.updated;
          errors += result.errors;
        } catch (err) {
          logger.error('Failed to sync votes for proposal', err);
          errors++;
        }
      }

      const durationMs = Date.now() - startTime;
      logger.info('Vote sync completed', {
        created,
        updated,
        deleted,
        errors,
        durationMs,
      });

      return { created, updated, deleted, errors, durationMs };
    } catch (err) {
      logger.error('Vote sync failed', err);
      throw err;
    }
  }

  /**
   * Sync votes for a specific proposal
   */
  private async syncVotesForProposal(proposalHash: string): Promise<{
    created: number;
    updated: number;
    errors: number;
  }> {
    let created = 0;
    let updated = 0;
    let errors = 0;

    try {
      // Get votes from Dash Core
      const coreVotes = await this.dashCore.getGovernanceVotes(proposalHash);
      logger.debug('Fetched votes from Core', {
        proposalHash,
        count: coreVotes.length,
      });

      for (const vote of coreVotes) {
        try {
          const voteData: VoteData = {
            proposalHash: normalizeHash(proposalHash),
            proTxHash: normalizeHash(vote.proTxHash),
            outcome: vote.outcome,
            timestamp: vote.timestamp,
            voteSignature: vote.voteHash,
          };

          const result = await this.publisher.upsertMasternodeVote(voteData);
          if (result.created) {
            created++;
          } else {
            updated++;
          }
        } catch (err) {
          logger.debug('Failed to sync vote', {
            proposalHash,
            proTxHash: vote.proTxHash,
            error: err instanceof Error ? err.message : String(err),
          });
          errors++;
        }
      }
    } catch (err) {
      logger.error('Failed to fetch votes from Core', {
        proposalHash,
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
    }

    return { created, updated, errors };
  }
}

// Singleton instance
let syncInstance: VoteSync | null = null;

export function getVoteSync(): VoteSync {
  if (!syncInstance) {
    syncInstance = new VoteSync();
  }
  return syncInstance;
}
