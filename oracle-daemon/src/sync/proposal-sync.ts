import { getDashCoreClient } from '../core/dash-core-client.js';
import { getPlatformPublisher } from '../core/platform-publisher.js';
import { createLogger } from '../utils/logger.js';
import { normalizeHash } from '../utils/hash-utils.js';
import {
  GovernanceObject,
  ProposalData,
  ProposalDataString,
  SyncResult,
} from '../types.js';
import {
  blockHeightToEpoch,
  calculateProposalStatus,
  calculateFundingThreshold,
} from './status-calculator.js';

const logger = createLogger('ProposalSync');

export class ProposalSync {
  private dashCore = getDashCoreClient();
  private publisher = getPlatformPublisher();

  /**
   * Sync all proposals from Dash Core to Platform
   */
  async sync(): Promise<SyncResult> {
    const startTime = Date.now();
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let errors = 0;

    try {
      logger.info('Starting proposal sync');

      // 1. Fetch all governance objects from Dash Core
      const gobjects = await this.dashCore.getGovernanceObjects();
      logger.debug('Fetched governance objects', { count: gobjects.length });

      // 2. Filter to type 1 (proposals only)
      const proposals = gobjects.filter(g => g.ObjectType === 1);
      logger.info('Found proposals', { count: proposals.length });

      // 3. Get current masternode count for threshold calculation
      const mnCount = await this.dashCore.getMasternodeCount();
      logger.debug('Masternode count', { total: mnCount.total, enabled: mnCount.enabled });

      // 4. Get current block height for epoch calculation
      const blockHeight = await this.dashCore.getBlockCount();
      const currentEpoch = blockHeightToEpoch(blockHeight);
      logger.debug('Current block state', { blockHeight, currentEpoch });

      // 5. Transform and sync each proposal
      const processedHashes = new Set<string>();

      for (const gobject of proposals) {
        try {
          const proposalData = await this.transformProposal(
            gobject,
            mnCount.enabled,
            currentEpoch
          );

          if (!proposalData) {
            logger.warn('Skipping invalid proposal', { hash: gobject.Hash });
            continue;
          }

          processedHashes.add(normalizeHash(proposalData.proposalHash));

          const result = await this.publisher.upsertProposal(proposalData);
          if (result.created) {
            created++;
          } else {
            updated++;
          }
        } catch (err) {
          logger.error(`Failed to sync proposal ${gobject.Hash}`, err);
          errors++;
        }
      }

      // 6. Delete proposals that no longer exist in Dash Core
      const platformProposals = await this.publisher.getAllProposals();
      for (const doc of platformProposals) {
        const docData = doc as unknown as { proposalHash?: number[] };
        if (!docData.proposalHash) continue;

        // Convert byte array back to hex for comparison
        const hash = Array.from(docData.proposalHash)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        if (!processedHashes.has(normalizeHash(hash))) {
          try {
            await this.publisher.deleteProposal(hash);
            deleted++;
            logger.info('Deleted stale proposal', { hash });
          } catch (err) {
            logger.error(`Failed to delete proposal ${hash}`, err);
            errors++;
          }
        }
      }

      const durationMs = Date.now() - startTime;
      logger.info('Proposal sync completed', {
        created,
        updated,
        deleted,
        errors,
        durationMs,
      });

      return { created, updated, deleted, errors, durationMs };
    } catch (err) {
      logger.error('Proposal sync failed', err);
      throw err;
    }
  }

  /**
   * Transform a governance object into proposal data
   */
  private async transformProposal(
    gobject: GovernanceObject,
    enabledMasternodes: number,
    currentEpoch: number
  ): Promise<ProposalData | null> {
    try {
      // Parse the DataString JSON
      const data: ProposalDataString = JSON.parse(gobject.DataString);

      // Validate required fields
      if (!data.name || !data.url || !data.payment_address) {
        logger.warn('Proposal missing required fields', { hash: gobject.Hash });
        return null;
      }

      const funding = gobject.FundingResult;

      // Calculate funding threshold (10% of enabled masternodes)
      const fundingThreshold = calculateFundingThreshold(enabledMasternodes);

      // Calculate status
      const status = calculateProposalStatus(
        data.end_epoch,
        currentEpoch,
        funding.YesCount,
        funding.NoCount,
        fundingThreshold,
        gobject.fCachedFunding
      );

      // Extract collateral public key (for authorship verification)
      let collateralPubKey: string | undefined;
      try {
        collateralPubKey = await this.extractCollateralPubKey(gobject.CollateralHash);
      } catch (err) {
        logger.debug('Could not extract collateral pubkey', {
          hash: gobject.Hash,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return {
        proposalHash: normalizeHash(gobject.Hash),
        gobjectType: gobject.ObjectType,
        name: data.name.slice(0, 40), // Max 40 chars per contract
        url: data.url.slice(0, 256), // Max 256 chars per contract
        paymentAddress: data.payment_address,
        paymentAmount: Math.round(data.payment_amount * 100000000), // DASH to duffs
        startEpoch: data.start_epoch,
        endEpoch: data.end_epoch,
        status,
        yesCount: funding.YesCount,
        noCount: funding.NoCount,
        abstainCount: funding.AbstainCount,
        totalMasternodes: enabledMasternodes,
        fundingThreshold,
        lastUpdatedAt: Date.now(),
        createdAtBlockHeight: gobject.CreationTime,
        collateralHash: normalizeHash(gobject.CollateralHash),
        collateralPubKey,
      };
    } catch (err) {
      logger.error('Failed to transform proposal', {
        hash: gobject.Hash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Extract the public key from the collateral transaction
   * Used for verifying authorship claims
   */
  private async extractCollateralPubKey(collateralHash: string): Promise<string | undefined> {
    try {
      // Fetch the raw transaction with verbose output
      const tx = await this.dashCore.getRawTransaction(collateralHash, true);

      // The collateral is a 5 DASH output - find it
      for (const vout of tx.vout) {
        // Look for the 5 DASH output
        if (vout.value === 5) {
          const scriptPubKey = vout.scriptPubKey;

          // P2PK: "<pubkey> OP_CHECKSIG"
          if (scriptPubKey.asm && !scriptPubKey.asm.includes('OP_DUP') && scriptPubKey.asm.includes('OP_CHECKSIG')) {
            const pubkey = scriptPubKey.asm.split(' ')[0];
            if (pubkey.length === 66 || pubkey.length === 130) {
              return pubkey;
            }
          }

          // P2PKH: Return the address (verification will use address-based signing)
          if (scriptPubKey.addresses && scriptPubKey.addresses[0]) {
            return scriptPubKey.addresses[0];
          }
          if (scriptPubKey.address) {
            return scriptPubKey.address;
          }
        }
      }

      logger.debug('Could not find 5 DASH output in collateral tx', { hash: collateralHash });
      return undefined;
    } catch (err) {
      logger.debug('Failed to fetch collateral tx', {
        hash: collateralHash,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}

// Singleton instance
let syncInstance: ProposalSync | null = null;

export function getProposalSync(): ProposalSync {
  if (!syncInstance) {
    syncInstance = new ProposalSync();
  }
  return syncInstance;
}
