/**
 * Governance Service
 *
 * Handles querying governance data from Dash Platform including:
 * - Proposals (synced from Dash Core by oracle)
 * - Proposal claims (user-created authorship claims)
 * - Masternode records and votes (synced from Dash Core by oracle)
 *
 * All hash fields (proposalHash, proTxHash) are stored as 32-byte arrays on Platform
 * but displayed as 64-character lowercase hex strings (matching Dash Core format).
 */

import { BaseDocumentService, QueryOptions, DocumentResult } from './document-service';
import { getEvoSdk } from './evo-sdk-service';
import {
  normalizeSDKResponse,
  RequestDeduplicator,
  bytesToHex,
  hexToBytes,
  identifierToBase58,
  toUint8Array,
  type DocumentWhereClause
} from './sdk-helpers';
import { YAPPR_GOVERNANCE_CONTRACT_ID, DOCUMENT_TYPES } from '../constants';
import type {
  Proposal,
  ProposalClaim,
  MasternodeRecord,
  MasternodeVote,
  ProposalStatus,
  VoteOutcome
} from '../types';

// Constants
const DUFFS_PER_DASH = 100_000_000;

// ============================================================================
// Raw Document Interfaces (matching contract schema)
// ============================================================================

export interface ProposalDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  $revision?: number;
  proposalHash: Uint8Array | number[] | string; // 32 bytes
  gobjectType: number;
  name: string;
  url: string;
  paymentAddress: string;
  paymentAmount: number;
  startEpoch: number;
  endEpoch: number;
  status: ProposalStatus;
  yesCount: number;
  noCount: number;
  abstainCount: number;
  totalMasternodes: number;
  fundingThreshold: number;
  lastUpdatedAt: number;
  createdAtBlockHeight?: number;
  collateralHash?: string;
  collateralPubKey?: string;
}

export interface ProposalClaimDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  proposalHash: Uint8Array | number[] | string; // 32 bytes
  linkedPostId: Uint8Array | number[] | string; // 32 bytes (Platform identifier)
  proofMessage?: string;
  proofSignature?: string;
}

export interface MasternodeRecordDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  $revision?: number;
  proTxHash: Uint8Array | number[] | string; // 32 bytes
  votingKeyHash: Uint8Array | number[] | string; // 20 bytes
  ownerKeyHash?: string;
  payoutAddress?: string;
  isEnabled: boolean;
  lastUpdatedAt: number;
}

export interface MasternodeVoteDocument {
  $id: string;
  $ownerId: string;
  $createdAt: number;
  $updatedAt?: number;
  $revision?: number;
  proposalHash: Uint8Array | number[] | string; // 32 bytes
  proTxHash: Uint8Array | number[] | string; // 32 bytes
  outcome: VoteOutcome;
  timestamp: number;
  voteSignature?: string;
}

// ============================================================================
// Conversion Utilities
// ============================================================================

/**
 * Convert a byte array field to a hex string.
 * Handles Uint8Array, number[], and base64/base58 strings.
 */
function byteFieldToHex(value: unknown): string {
  if (!value) return '';

  // Already a hex string (64 chars for 32 bytes, 40 chars for 20 bytes)
  if (typeof value === 'string' && /^[0-9a-f]+$/i.test(value)) {
    return value.toLowerCase();
  }

  // Convert to Uint8Array first
  const bytes = toUint8Array(value);
  if (bytes) {
    return bytesToHex(bytes);
  }

  // Try as Uint8Array or number[] directly
  if (value instanceof Uint8Array) {
    return bytesToHex(value);
  }
  if (Array.isArray(value) && value.every(n => typeof n === 'number')) {
    return bytesToHex(new Uint8Array(value));
  }

  console.warn('byteFieldToHex: Unable to convert value:', typeof value);
  return '';
}

/**
 * Convert a hex string to byte array for SDK queries.
 * Returns an Array<number> because the SDK serializes Uint8Array incorrectly.
 */
function hexToQueryBytes(hex: string): number[] {
  return Array.from(hexToBytes(hex));
}

// ============================================================================
// Transform Functions
// ============================================================================

/**
 * Transform raw proposal document to display-friendly Proposal type.
 */
function transformProposal(doc: Record<string, unknown>): Proposal {
  const data = (doc.data || doc) as ProposalDocument;

  const proposalHash = byteFieldToHex(data.proposalHash || doc.proposalHash);
  const yesCount = (data.yesCount || 0) as number;
  const noCount = (data.noCount || 0) as number;
  const netVotes = yesCount - noCount;
  const fundingThreshold = (data.fundingThreshold || 0) as number;
  const votesNeeded = Math.max(0, fundingThreshold - netVotes);
  const voteProgress = fundingThreshold > 0 ? (netVotes / fundingThreshold) * 100 : 0;
  const paymentAmount = (data.paymentAmount || 0) as number;

  return {
    id: (doc.$id || doc.id) as string,
    hash: proposalHash,
    gobjectType: (data.gobjectType || 1) as number,
    name: (data.name || '') as string,
    url: (data.url || '') as string,
    paymentAddress: (data.paymentAddress || '') as string,
    paymentAmount,
    paymentAmountDash: paymentAmount / DUFFS_PER_DASH,
    startEpoch: (data.startEpoch || 0) as number,
    endEpoch: (data.endEpoch || 0) as number,
    status: (data.status || 'active') as ProposalStatus,
    yesCount,
    noCount,
    abstainCount: (data.abstainCount || 0) as number,
    netVotes,
    totalMasternodes: (data.totalMasternodes || 0) as number,
    fundingThreshold,
    votesNeeded,
    voteProgress,
    lastUpdatedAt: new Date((data.lastUpdatedAt || 0) as number),
    createdAt: new Date((doc.$createdAt || doc.createdAt || 0) as number),
    createdAtBlockHeight: data.createdAtBlockHeight as number | undefined,
    collateralHash: data.collateralHash as string | undefined,
    collateralPubKey: data.collateralPubKey as string | undefined,
  };
}

/**
 * Transform raw proposal claim document to display-friendly ProposalClaim type.
 */
function transformProposalClaim(doc: Record<string, unknown>): ProposalClaim {
  const data = (doc.data || doc) as ProposalClaimDocument;

  // linkedPostId is a Platform identifier, convert to base58
  const rawLinkedPostId = data.linkedPostId || doc.linkedPostId;
  const linkedPostId = identifierToBase58(rawLinkedPostId) || '';

  return {
    id: (doc.$id || doc.id) as string,
    ownerId: (doc.$ownerId || doc.ownerId) as string,
    proposalHash: byteFieldToHex(data.proposalHash || doc.proposalHash),
    linkedPostId,
    proofMessage: data.proofMessage,
    proofSignature: data.proofSignature,
    createdAt: new Date((doc.$createdAt || doc.createdAt || 0) as number),
    // verified is computed client-side based on signature verification
  };
}

/**
 * Transform raw masternode record document to display-friendly type.
 */
function transformMasternodeRecord(doc: Record<string, unknown>): MasternodeRecord {
  const data = (doc.data || doc) as MasternodeRecordDocument;

  return {
    id: (doc.$id || doc.id) as string,
    proTxHash: byteFieldToHex(data.proTxHash || doc.proTxHash),
    votingKeyHash: byteFieldToHex(data.votingKeyHash || doc.votingKeyHash),
    ownerKeyHash: data.ownerKeyHash,
    payoutAddress: data.payoutAddress,
    isEnabled: (data.isEnabled ?? true) as boolean,
    lastUpdatedAt: new Date((data.lastUpdatedAt || 0) as number),
  };
}

/**
 * Transform raw masternode vote document to display-friendly type.
 */
function transformMasternodeVote(doc: Record<string, unknown>): MasternodeVote {
  const data = (doc.data || doc) as MasternodeVoteDocument;

  return {
    id: (doc.$id || doc.id) as string,
    proposalHash: byteFieldToHex(data.proposalHash || doc.proposalHash),
    proTxHash: byteFieldToHex(data.proTxHash || doc.proTxHash),
    outcome: (data.outcome || 'abstain') as VoteOutcome,
    timestamp: new Date((data.timestamp || 0) as number * 1000), // Unix timestamp to Date
    voteSignature: data.voteSignature,
  };
}

// ============================================================================
// Governance Service
// ============================================================================

class GovernanceService extends BaseDocumentService<Proposal> {
  private proposalByHashDeduplicator = new RequestDeduplicator<string, Proposal | null>();
  private proposalCountDeduplicator = new RequestDeduplicator<string, number>();

  constructor() {
    super(DOCUMENT_TYPES.PROPOSAL, YAPPR_GOVERNANCE_CONTRACT_ID);
  }

  protected transformDocument(doc: Record<string, unknown>): Proposal {
    return transformProposal(doc);
  }

  // ==========================================================================
  // Proposal Queries
  // ==========================================================================

  /**
   * Get all proposals with optional filtering by status.
   */
  async getProposals(options: {
    status?: ProposalStatus;
    limit?: number;
    startAfter?: string;
  } = {}): Promise<DocumentResult<Proposal>> {
    try {
      const where: DocumentWhereClause[] = [];

      if (options.status) {
        where.push(['status', '==', options.status]);
        where.push(['endEpoch', '>', 0]);
      } else {
        // Use timeline index for "all proposals"
        where.push(['$createdAt', '>', 0]);
      }

      const queryOptions: QueryOptions = {
        where,
        orderBy: options.status
          ? [['status', 'asc'], ['endEpoch', 'asc']]
          : [['$createdAt', 'asc']],
        limit: options.limit || 20,
        startAfter: options.startAfter,
      };

      return await this.query(queryOptions);
    } catch (error) {
      console.error('GovernanceService.getProposals error:', error);
      return { documents: [] };
    }
  }

  /**
   * Get a single proposal by its governance object hash.
   */
  async getProposalByHash(proposalHash: string): Promise<Proposal | null> {
    return this.proposalByHashDeduplicator.dedupe(proposalHash, async () => {
      try {
        const sdk = await getEvoSdk();

        // Convert hex hash to byte array for query
        const hashBytes = hexToQueryBytes(proposalHash.toLowerCase());

        const response = await sdk.documents.query({
          dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
          documentTypeName: DOCUMENT_TYPES.PROPOSAL,
          where: [['proposalHash', '==', hashBytes]],
          limit: 1,
        });

        const documents = normalizeSDKResponse(response);
        if (documents.length === 0) return null;

        return transformProposal(documents[0]);
      } catch (error) {
        console.error('GovernanceService.getProposalByHash error:', error);
        return null;
      }
    });
  }

  /**
   * Get active proposals (voting open).
   */
  async getActiveProposals(limit = 20): Promise<Proposal[]> {
    const result = await this.getProposals({ status: 'active', limit });
    return result.documents;
  }

  /**
   * Count proposals by status.
   */
  async countProposalsByStatus(status: ProposalStatus): Promise<number> {
    return this.proposalCountDeduplicator.dedupe(status, async () => {
      try {
        const result = await this.getProposals({ status, limit: 100 });
        return result.documents.length;
      } catch (error) {
        console.error('GovernanceService.countProposalsByStatus error:', error);
        return 0;
      }
    });
  }

  // ==========================================================================
  // Proposal Claim Queries
  // ==========================================================================

  /**
   * Get all claims for a proposal.
   */
  async getClaimsForProposal(proposalHash: string): Promise<ProposalClaim[]> {
    try {
      const sdk = await getEvoSdk();
      const hashBytes = hexToQueryBytes(proposalHash.toLowerCase());

      const response = await sdk.documents.query({
        dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPES.PROPOSAL_CLAIM,
        where: [
          ['proposalHash', '==', hashBytes],
          ['$createdAt', '>', 0],
        ],
        orderBy: [['proposalHash', 'asc'], ['$createdAt', 'asc']],
        limit: 100,
      });

      const documents = normalizeSDKResponse(response);
      return documents.map(transformProposalClaim);
    } catch (error) {
      console.error('GovernanceService.getClaimsForProposal error:', error);
      return [];
    }
  }

  /**
   * Get claims by a specific user.
   */
  async getClaimsByUser(userId: string): Promise<ProposalClaim[]> {
    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPES.PROPOSAL_CLAIM,
        where: [
          ['$ownerId', '==', userId],
          ['$createdAt', '>', 0],
        ],
        orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']],
        limit: 100,
      });

      const documents = normalizeSDKResponse(response);
      return documents.map(transformProposalClaim);
    } catch (error) {
      console.error('GovernanceService.getClaimsByUser error:', error);
      return [];
    }
  }

  /**
   * Check if a user has already claimed a proposal.
   */
  async hasUserClaimedProposal(proposalHash: string, userId: string): Promise<boolean> {
    try {
      const sdk = await getEvoSdk();
      const hashBytes = hexToQueryBytes(proposalHash.toLowerCase());

      const response = await sdk.documents.query({
        dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPES.PROPOSAL_CLAIM,
        where: [
          ['proposalHash', '==', hashBytes],
          ['$ownerId', '==', userId],
        ],
        limit: 1,
      });

      const documents = normalizeSDKResponse(response);
      return documents.length > 0;
    } catch (error) {
      console.error('GovernanceService.hasUserClaimedProposal error:', error);
      return false;
    }
  }

  /**
   * Get a claim by its linked post ID.
   */
  async getClaimByLinkedPost(linkedPostId: string): Promise<ProposalClaim | null> {
    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPES.PROPOSAL_CLAIM,
        where: [['linkedPostId', '==', linkedPostId]],
        limit: 1,
      });

      const documents = normalizeSDKResponse(response);
      if (documents.length === 0) return null;

      return transformProposalClaim(documents[0]);
    } catch (error) {
      console.error('GovernanceService.getClaimByLinkedPost error:', error);
      return null;
    }
  }

  // ==========================================================================
  // Masternode Vote Queries
  // ==========================================================================

  /**
   * Get votes for a proposal with optional filtering by outcome.
   */
  async getVotesForProposal(
    proposalHash: string,
    options: { outcome?: VoteOutcome; limit?: number } = {}
  ): Promise<MasternodeVote[]> {
    try {
      const sdk = await getEvoSdk();
      const hashBytes = hexToQueryBytes(proposalHash.toLowerCase());

      const where: DocumentWhereClause[] = [
        ['proposalHash', '==', hashBytes],
      ];

      if (options.outcome) {
        where.push(['outcome', '==', options.outcome]);
        where.push(['timestamp', '>', 0]);
      } else {
        where.push(['proTxHash', '>', new Array(32).fill(0)]);
      }

      const response = await sdk.documents.query({
        dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPES.MASTERNODE_VOTE,
        where,
        orderBy: options.outcome
          ? [['proposalHash', 'asc'], ['outcome', 'asc'], ['timestamp', 'asc']]
          : [['proposalHash', 'asc'], ['proTxHash', 'asc']],
        limit: options.limit || 100,
      });

      const documents = normalizeSDKResponse(response);
      return documents.map(transformMasternodeVote);
    } catch (error) {
      console.error('GovernanceService.getVotesForProposal error:', error);
      return [];
    }
  }

  /**
   * Get voting history for a masternode.
   */
  async getVotesByMasternode(proTxHash: string, limit = 50): Promise<MasternodeVote[]> {
    try {
      const sdk = await getEvoSdk();
      const hashBytes = hexToQueryBytes(proTxHash.toLowerCase());

      const response = await sdk.documents.query({
        dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPES.MASTERNODE_VOTE,
        where: [
          ['proTxHash', '==', hashBytes],
          ['timestamp', '>', 0],
        ],
        orderBy: [['proTxHash', 'asc'], ['timestamp', 'asc']],
        limit,
      });

      const documents = normalizeSDKResponse(response);
      return documents.map(transformMasternodeVote);
    } catch (error) {
      console.error('GovernanceService.getVotesByMasternode error:', error);
      return [];
    }
  }

  // ==========================================================================
  // Masternode Record Queries
  // ==========================================================================

  /**
   * Get a masternode record by its ProRegTx hash.
   */
  async getMasternodeByProTxHash(proTxHash: string): Promise<MasternodeRecord | null> {
    try {
      const sdk = await getEvoSdk();
      const hashBytes = hexToQueryBytes(proTxHash.toLowerCase());

      const response = await sdk.documents.query({
        dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPES.MASTERNODE_RECORD,
        where: [['proTxHash', '==', hashBytes]],
        limit: 1,
      });

      const documents = normalizeSDKResponse(response);
      if (documents.length === 0) return null;

      return transformMasternodeRecord(documents[0]);
    } catch (error) {
      console.error('GovernanceService.getMasternodeByProTxHash error:', error);
      return null;
    }
  }

  /**
   * Get enabled masternodes.
   */
  async getEnabledMasternodes(limit = 100): Promise<MasternodeRecord[]> {
    try {
      const sdk = await getEvoSdk();

      const response = await sdk.documents.query({
        dataContractId: YAPPR_GOVERNANCE_CONTRACT_ID,
        documentTypeName: DOCUMENT_TYPES.MASTERNODE_RECORD,
        where: [
          ['isEnabled', '==', true],
          ['$createdAt', '>', 0],
        ],
        orderBy: [['isEnabled', 'asc'], ['$createdAt', 'asc']],
        limit,
      });

      const documents = normalizeSDKResponse(response);
      return documents.map(transformMasternodeRecord);
    } catch (error) {
      console.error('GovernanceService.getEnabledMasternodes error:', error);
      return [];
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Generate a vote command for masternode operators.
   * Command format: gobject vote-many <hash> funding <yes|no|abstain>
   */
  generateVoteCommand(proposalHash: string, outcome: VoteOutcome): string {
    return `gobject vote-many ${proposalHash} funding ${outcome}`;
  }

  /**
   * Calculate vote progress percentage (can be > 100% if exceeded threshold).
   */
  calculateVoteProgress(yesCount: number, noCount: number, fundingThreshold: number): number {
    if (fundingThreshold <= 0) return 0;
    const netVotes = yesCount - noCount;
    return (netVotes / fundingThreshold) * 100;
  }

  /**
   * Convert payment amount from duffs to DASH.
   */
  duffsToDash(duffs: number): number {
    return duffs / DUFFS_PER_DASH;
  }

  /**
   * Convert payment amount from DASH to duffs.
   */
  dashToDuffs(dash: number): number {
    return Math.round(dash * DUFFS_PER_DASH);
  }
}

// Singleton instance
export const governanceService = new GovernanceService();

// Export types for consumers
export type {
  Proposal,
  ProposalClaim,
  MasternodeRecord,
  MasternodeVote,
  ProposalStatus,
  VoteOutcome
} from '../types';
