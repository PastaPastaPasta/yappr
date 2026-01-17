import { ProposalStatus } from '../types';

// Dash mainnet superblock interval is 16616 blocks
// Testnet may vary
const SUPERBLOCK_INTERVAL = 16616;

// First mainnet superblock height
const FIRST_SUPERBLOCK_HEIGHT = 212064;

/**
 * Convert a block height to an epoch number
 */
export function blockHeightToEpoch(blockHeight: number): number {
  if (blockHeight < FIRST_SUPERBLOCK_HEIGHT) {
    return 0;
  }
  return Math.floor((blockHeight - FIRST_SUPERBLOCK_HEIGHT) / SUPERBLOCK_INTERVAL);
}

/**
 * Convert an epoch number to approximate block height
 */
export function epochToBlockHeight(epoch: number): number {
  return FIRST_SUPERBLOCK_HEIGHT + (epoch * SUPERBLOCK_INTERVAL);
}

/**
 * Get the next superblock height after a given height
 */
export function getNextSuperblockHeight(blockHeight: number): number {
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
export function calculateProposalStatus(
  endEpoch: number,
  currentEpoch: number,
  yesCount: number,
  noCount: number,
  fundingThreshold: number,
  isFunded: boolean
): ProposalStatus {
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
export function calculateFundingThreshold(enabledMasternodes: number): number {
  return Math.ceil(enabledMasternodes * 0.1);
}

/**
 * Calculate net votes (yes - no)
 */
export function calculateNetVotes(yesCount: number, noCount: number): number {
  return yesCount - noCount;
}

/**
 * Calculate votes still needed for funding
 */
export function calculateVotesNeeded(
  yesCount: number,
  noCount: number,
  fundingThreshold: number
): number {
  const netVotes = yesCount - noCount;
  return Math.max(0, fundingThreshold - netVotes);
}

/**
 * Calculate vote progress percentage toward threshold
 */
export function calculateVoteProgress(
  yesCount: number,
  noCount: number,
  fundingThreshold: number
): number {
  if (fundingThreshold === 0) {
    return 100;
  }
  const netVotes = yesCount - noCount;
  const progress = (netVotes / fundingThreshold) * 100;
  return Math.min(100, Math.max(0, progress));
}
