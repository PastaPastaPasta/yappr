"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoteSync = void 0;
exports.getVoteSync = getVoteSync;
const dash_core_client_1 = require("../core/dash-core-client");
const platform_publisher_1 = require("../core/platform-publisher");
const logger_1 = require("../utils/logger");
const hash_utils_1 = require("../utils/hash-utils");
const logger = (0, logger_1.createLogger)('VoteSync');
class VoteSync {
    constructor() {
        this.dashCore = (0, dash_core_client_1.getDashCoreClient)();
        this.publisher = (0, platform_publisher_1.getPlatformPublisher)();
    }
    /**
     * Sync votes for all active proposals
     */
    async sync() {
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
                    const proposalData = proposal;
                    if (!proposalData.proposalHash)
                        continue;
                    // Convert byte array to hex
                    const proposalHash = (0, hash_utils_1.bytesToHex)(proposalData.proposalHash);
                    const result = await this.syncVotesForProposal(proposalHash);
                    created += result.created;
                    updated += result.updated;
                    errors += result.errors;
                }
                catch (err) {
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
        }
        catch (err) {
            logger.error('Vote sync failed', err);
            throw err;
        }
    }
    /**
     * Sync votes for a specific proposal
     */
    async syncVotesForProposal(proposalHash) {
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
                    const voteData = {
                        proposalHash: (0, hash_utils_1.normalizeHash)(proposalHash),
                        proTxHash: (0, hash_utils_1.normalizeHash)(vote.proTxHash),
                        outcome: vote.outcome,
                        timestamp: vote.timestamp,
                        voteSignature: vote.voteHash,
                    };
                    const result = await this.publisher.upsertMasternodeVote(voteData);
                    if (result.created) {
                        created++;
                    }
                    else {
                        updated++;
                    }
                }
                catch (err) {
                    logger.debug('Failed to sync vote', {
                        proposalHash,
                        proTxHash: vote.proTxHash,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    errors++;
                }
            }
        }
        catch (err) {
            logger.error('Failed to fetch votes from Core', {
                proposalHash,
                error: err instanceof Error ? err.message : String(err),
            });
            errors++;
        }
        return { created, updated, errors };
    }
}
exports.VoteSync = VoteSync;
// Singleton instance
let syncInstance = null;
function getVoteSync() {
    if (!syncInstance) {
        syncInstance = new VoteSync();
    }
    return syncInstance;
}
//# sourceMappingURL=vote-sync.js.map