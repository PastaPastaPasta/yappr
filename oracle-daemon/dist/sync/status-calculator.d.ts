import { ProposalStatus } from '../types';
/**
 * Convert a block height to an epoch number
 */
export declare function blockHeightToEpoch(blockHeight: number): number;
/**
 * Convert an epoch number to approximate block height
 */
export declare function epochToBlockHeight(epoch: number): number;
/**
 * Get the next superblock height after a given height
 */
export declare function getNextSuperblockHeight(blockHeight: number): number;
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
export declare function calculateProposalStatus(endEpoch: number, currentEpoch: number, yesCount: number, noCount: number, fundingThreshold: number, isFunded: boolean): ProposalStatus;
/**
 * Calculate the funding threshold (10% of enabled masternodes)
 */
export declare function calculateFundingThreshold(enabledMasternodes: number): number;
/**
 * Calculate net votes (yes - no)
 */
export declare function calculateNetVotes(yesCount: number, noCount: number): number;
/**
 * Calculate votes still needed for funding
 */
export declare function calculateVotesNeeded(yesCount: number, noCount: number, fundingThreshold: number): number;
/**
 * Calculate vote progress percentage toward threshold
 */
export declare function calculateVoteProgress(yesCount: number, noCount: number, fundingThreshold: number): number;
//# sourceMappingURL=status-calculator.d.ts.map