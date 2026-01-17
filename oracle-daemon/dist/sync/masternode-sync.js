"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MasternodeSync = void 0;
exports.getMasternodeSync = getMasternodeSync;
const dash_core_client_1 = require("../core/dash-core-client");
const platform_publisher_1 = require("../core/platform-publisher");
const logger_1 = require("../utils/logger");
const hash_utils_1 = require("../utils/hash-utils");
const crypto_1 = require("crypto");
const logger = (0, logger_1.createLogger)('MasternodeSync');
/**
 * Hash a voting address to get a 20-byte hash160
 * This is a simplified version - real implementation would use proper base58 decoding
 */
function hashAddress(address) {
    // Create a SHA256 hash first, then take first 20 bytes as hex
    // This is a placeholder - real implementation should decode base58check
    // and extract the 20-byte pubkey hash
    const hash = (0, crypto_1.createHash)('sha256').update(address).digest();
    return hash.slice(0, 20).toString('hex');
}
class MasternodeSync {
    constructor() {
        this.dashCore = (0, dash_core_client_1.getDashCoreClient)();
        this.publisher = (0, platform_publisher_1.getPlatformPublisher)();
    }
    /**
     * Sync masternode list from Dash Core to Platform
     */
    async sync() {
        const startTime = Date.now();
        let created = 0;
        let updated = 0;
        const deleted = 0;
        let errors = 0;
        try {
            logger.info('Starting masternode sync');
            // Get full masternode list
            const mnList = await this.dashCore.getMasternodeList();
            logger.info('Fetched masternode list', { count: mnList.length });
            // Process each masternode
            for (const mn of mnList) {
                try {
                    // Calculate voting key hash from voting address
                    const votingKeyHash = mn.votingAddress
                        ? hashAddress(mn.votingAddress)
                        : hashAddress(mn.proTxHash); // Fallback
                    const mnData = {
                        proTxHash: (0, hash_utils_1.normalizeHash)(mn.proTxHash),
                        votingKeyHash,
                        ownerKeyHash: mn.ownerAddress ? hashAddress(mn.ownerAddress) : undefined,
                        payoutAddress: mn.payee || undefined,
                        isEnabled: mn.status === 'ENABLED',
                        lastUpdatedAt: Date.now(),
                    };
                    const result = await this.publisher.upsertMasternodeRecord(mnData);
                    if (result.created) {
                        created++;
                    }
                    else {
                        updated++;
                    }
                }
                catch (err) {
                    logger.debug('Failed to sync masternode', {
                        proTxHash: mn.proTxHash,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    errors++;
                }
            }
            const durationMs = Date.now() - startTime;
            logger.info('Masternode sync completed', {
                created,
                updated,
                deleted,
                errors,
                durationMs,
                totalMasternodes: mnList.length,
            });
            return { created, updated, deleted, errors, durationMs };
        }
        catch (err) {
            logger.error('Masternode sync failed', err);
            throw err;
        }
    }
}
exports.MasternodeSync = MasternodeSync;
// Singleton instance
let syncInstance = null;
function getMasternodeSync() {
    if (!syncInstance) {
        syncInstance = new MasternodeSync();
    }
    return syncInstance;
}
//# sourceMappingURL=masternode-sync.js.map