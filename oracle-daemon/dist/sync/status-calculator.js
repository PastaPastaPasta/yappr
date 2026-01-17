"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.blockHeightToEpoch = blockHeightToEpoch;
exports.epochToBlockHeight = epochToBlockHeight;
exports.getNextSuperblockHeight = getNextSuperblockHeight;
exports.calculateProposalStatus = calculateProposalStatus;
exports.calculateFundingThreshold = calculateFundingThreshold;
exports.calculateNetVotes = calculateNetVotes;
exports.calculateVotesNeeded = calculateVotesNeeded;
exports.calculateVoteProgress = calculateVoteProgress;
// Dash mainnet superblock interval is 16616 blocks
// Testnet may vary
const SUPERBLOCK_INTERVAL = 16616;
// First mainnet superblock height
const FIRST_SUPERBLOCK_HEIGHT = 212064;
/**
 * Convert a block height to an epoch number
 */
function blockHeightToEpoch(blockHeight) {
    if (blockHeight < FIRST_SUPERBLOCK_HEIGHT) {
        return 0;
    }
    return Math.floor((blockHeight - FIRST_SUPERBLOCK_HEIGHT) / SUPERBLOCK_INTERVAL);
}
/**
 * Convert an epoch number to approximate block height
 */
function epochToBlockHeight(epoch) {
    return FIRST_SUPERBLOCK_HEIGHT + (epoch * SUPERBLOCK_INTERVAL);
}
/**
 * Get the next superblock height after a given height
 */
function getNextSuperblockHeight(blockHeight) {
    const currentEpoch = blockHeightToEpoch(blockHeight);
    return epochToBlockHeight(currentEpoch + 1);
}
/**
 * Calculate proposal status based on voting data and epoch
 *
 * Status values:
 * - active: endEpoch > current epoch AND voting open
 * - passed: yesCount - noCount >= fundingThreshold
 * - failed: yesCount - noCount < fundingThreshold AND voting closed
 * - funded: passed AND payout transaction confirmed
 * - expired: endEpoch < current epoch
 */
function calculateProposalStatus(endEpoch, currentEpoch, yesCount, noCount, fundingThreshold, isFunded) {
    const netVotes = yesCount - noCount;
    const hasPassedThreshold = netVotes >= fundingThreshold;
    // If marked as funded by Dash Core
    if (isFunded) {
        return 'funded';
    }
    // If voting period has ended
    if (endEpoch < currentEpoch) {
        // Voting closed - check if it passed
        return hasPassedThreshold ? 'passed' : 'expired';
    }
    // Voting is still open
    if (hasPassedThreshold) {
        return 'passed';
    }
    return 'active';
}
/**
 * Calculate the funding threshold (10% of enabled masternodes)
 */
function calculateFundingThreshold(enabledMasternodes) {
    return Math.ceil(enabledMasternodes * 0.1);
}
/**
 * Calculate net votes (yes - no)
 */
function calculateNetVotes(yesCount, noCount) {
    return yesCount - noCount;
}
/**
 * Calculate votes still needed for funding
 */
function calculateVotesNeeded(yesCount, noCount, fundingThreshold) {
    const netVotes = yesCount - noCount;
    return Math.max(0, fundingThreshold - netVotes);
}
/**
 * Calculate vote progress percentage toward threshold
 */
function calculateVoteProgress(yesCount, noCount, fundingThreshold) {
    if (fundingThreshold === 0) {
        return 100;
    }
    const netVotes = yesCount - noCount;
    const progress = (netVotes / fundingThreshold) * 100;
    return Math.min(100, Math.max(0, progress));
}
//# sourceMappingURL=status-calculator.js.map