import { EvoSDK } from '@dashevo/evo-sdk';
import { getConfig } from '../config';
import { createLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { hexToBytes, bytesToHex } from '../utils/hash-utils';
import {
  ProposalData,
  MasternodeData,
  VoteData,
  PlatformDocument,
} from '../types';
import { randomBytes } from 'crypto';

const logger = createLogger('PlatformPublisher');

// Document type names in the contract
const DOCUMENT_TYPES = {
  proposal: 'proposal',
  masternodeRecord: 'masternodeRecord',
  masternodeVote: 'masternodeVote',
} as const;

export class PlatformPublisher {
  private sdk: EvoSDK | null = null;
  private contractId: string;
  private identityId: string;
  private privateKey: string;

  constructor() {
    const config = getConfig();
    this.contractId = config.platform.contractId;
    this.identityId = config.platform.identityId;
    this.privateKey = config.platform.privateKey;
  }

  /**
   * Initialize the SDK connection
   */
  async initialize(): Promise<void> {
    if (this.sdk) {
      return;
    }

    const config = getConfig();

    logger.info('Initializing Platform SDK', {
      network: config.platform.network,
      contractId: this.contractId,
    });

    // Create SDK based on network
    if (config.platform.network === 'testnet') {
      this.sdk = EvoSDK.testnetTrusted({
        settings: {
          timeoutMs: 30000,
        }
      });
    } else {
      this.sdk = EvoSDK.mainnetTrusted({
        settings: {
          timeoutMs: 30000,
        }
      });
    }

    // Connect to the network
    await this.sdk.connect();

    // Preload the governance contract
    try {
      await this.sdk.contracts.fetch(this.contractId);
      logger.info('Governance contract cached');
    } catch (error) {
      logger.error('Failed to fetch governance contract', error);
      throw new Error(`Failed to fetch governance contract: ${this.contractId}`);
    }

    logger.info('Platform SDK initialized successfully');
  }

  /**
   * Disconnect from Platform
   */
  async disconnect(): Promise<void> {
    this.sdk = null;
  }

  /**
   * Ensure SDK is initialized
   */
  private ensureInitialized(): void {
    if (!this.sdk) {
      throw new Error('Platform publisher not initialized. Call initialize() first.');
    }
  }

  /**
   * Generate entropy for state transitions
   */
  private generateEntropy(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Query documents by type and conditions
   */
  async queryDocuments(
    documentType: string,
    where: Array<[string, string, unknown]>,
    options: { limit?: number; orderBy?: Array<[string, string]> } = {}
  ): Promise<PlatformDocument[]> {
    this.ensureInitialized();
    const config = getConfig();

    return withRetry(
      async () => {
        const query: Record<string, unknown> = {
          dataContractId: this.contractId,
          documentTypeName: documentType,
          where,
        };

        if (options.limit) {
          query.limit = options.limit;
        }
        if (options.orderBy) {
          query.orderBy = options.orderBy;
        }

        const response = await this.sdk!.documents.query(query);

        // Convert Map response to array
        const documents: PlatformDocument[] = [];
        if (response instanceof Map) {
          for (const doc of response.values()) {
            if (doc) {
              const data = typeof (doc as { toJSON?: () => unknown }).toJSON === 'function'
                ? (doc as { toJSON: () => unknown }).toJSON()
                : doc;
              documents.push(data as PlatformDocument);
            }
          }
        }

        return documents;
      },
      {
        attempts: config.sync.retryAttempts,
        delayMs: config.sync.retryDelayMs,
        onRetry: (attempt, error) => {
          logger.warn(`Query ${documentType} failed, retrying`, {
            attempt,
            error: error.message,
          });
        },
      }
    );
  }

  /**
   * Create a new document
   */
  private async createDocument(
    documentType: string,
    data: Record<string, unknown>
  ): Promise<string> {
    this.ensureInitialized();
    const config = getConfig();

    return withRetry(
      async () => {
        const result = await this.sdk!.documents.create({
          contractId: this.contractId,
          type: documentType,
          ownerId: this.identityId,
          data,
          entropyHex: this.generateEntropy(),
          privateKeyWif: this.privateKey,
        }) as unknown as { document?: { $id: string }; $id?: string };

        const docId = result.document?.$id || result.$id || 'unknown';
        logger.debug(`Created document: ${docId}`);
        return docId;
      },
      {
        attempts: config.sync.retryAttempts,
        delayMs: config.sync.retryDelayMs,
      }
    );
  }

  /**
   * Update an existing document
   */
  private async updateDocument(
    documentType: string,
    documentId: string,
    data: Record<string, unknown>,
    revision: number
  ): Promise<void> {
    this.ensureInitialized();
    const config = getConfig();

    await withRetry(
      async () => {
        await this.sdk!.documents.replace({
          contractId: this.contractId,
          type: documentType,
          documentId,
          ownerId: this.identityId,
          data,
          revision: BigInt(revision),
          privateKeyWif: this.privateKey,
        });

        logger.debug(`Updated document: ${documentId}`);
      },
      {
        attempts: config.sync.retryAttempts,
        delayMs: config.sync.retryDelayMs,
      }
    );
  }

  /**
   * Delete a document
   */
  private async deleteDocument(
    documentType: string,
    documentId: string
  ): Promise<void> {
    this.ensureInitialized();
    const config = getConfig();

    await withRetry(
      async () => {
        await this.sdk!.documents.delete({
          contractId: this.contractId,
          type: documentType,
          documentId,
          ownerId: this.identityId,
          privateKeyWif: this.privateKey,
        });

        logger.debug(`Deleted document: ${documentId}`);
      },
      {
        attempts: config.sync.retryAttempts,
        delayMs: config.sync.retryDelayMs,
      }
    );
  }

  // ==================== Proposal Operations ====================

  /**
   * Find a proposal by its governance object hash
   */
  async findProposalByHash(proposalHash: string): Promise<PlatformDocument | null> {
    // Convert hex hash to byte array for indexed query
    const hashBytes = hexToBytes(proposalHash);

    const documents = await this.queryDocuments(
      DOCUMENT_TYPES.proposal,
      [['proposalHash', '==', hashBytes]],
      { limit: 1 }
    );

    return documents.length > 0 ? documents[0] : null;
  }

  /**
   * Get all proposals
   */
  async getAllProposals(): Promise<PlatformDocument[]> {
    return this.queryDocuments(
      DOCUMENT_TYPES.proposal,
      [['$createdAt', '>', 0]],
      { orderBy: [['$createdAt', 'asc']] }
    );
  }

  /**
   * Get proposals by status
   */
  async getProposalsByStatus(status: string): Promise<PlatformDocument[]> {
    return this.queryDocuments(
      DOCUMENT_TYPES.proposal,
      [
        ['status', '==', status],
        ['endEpoch', '>', 0], // Required for index
      ],
      { orderBy: [['status', 'asc'], ['endEpoch', 'asc']] }
    );
  }

  /**
   * Create or update a proposal document
   */
  async upsertProposal(proposal: ProposalData): Promise<{ created: boolean }> {
    const existing = await this.findProposalByHash(proposal.proposalHash);

    // Convert hex hashes to byte arrays for storage
    const documentData = {
      proposalHash: hexToBytes(proposal.proposalHash),
      gobjectType: proposal.gobjectType,
      name: proposal.name,
      url: proposal.url,
      paymentAddress: proposal.paymentAddress,
      paymentAmount: proposal.paymentAmount,
      startEpoch: proposal.startEpoch,
      endEpoch: proposal.endEpoch,
      status: proposal.status,
      yesCount: proposal.yesCount,
      noCount: proposal.noCount,
      abstainCount: proposal.abstainCount,
      totalMasternodes: proposal.totalMasternodes,
      fundingThreshold: proposal.fundingThreshold,
      lastUpdatedAt: proposal.lastUpdatedAt,
      ...(proposal.createdAtBlockHeight !== undefined && {
        createdAtBlockHeight: proposal.createdAtBlockHeight,
      }),
      ...(proposal.collateralHash && {
        collateralHash: proposal.collateralHash,
      }),
      ...(proposal.collateralPubKey && {
        collateralPubKey: proposal.collateralPubKey,
      }),
    };

    if (existing) {
      // Check if data has changed
      if (this.hasProposalChanged(existing, proposal)) {
        logger.debug('Updating proposal', { hash: proposal.proposalHash });

        // Get revision from existing document
        const revision = (existing as unknown as { $revision?: number }).$revision || 1;

        await this.updateDocument(DOCUMENT_TYPES.proposal, existing.$id, {
          ...documentData,
        }, revision);
        return { created: false };
      }
      logger.debug('Proposal unchanged, skipping', { hash: proposal.proposalHash });
      return { created: false };
    } else {
      logger.info('Creating new proposal', { hash: proposal.proposalHash, name: proposal.name });
      await this.createDocument(DOCUMENT_TYPES.proposal, documentData);
      return { created: true };
    }
  }

  /**
   * Check if proposal data has changed (comparing relevant fields)
   */
  private hasProposalChanged(existing: PlatformDocument, proposal: ProposalData): boolean {
    const doc = existing as unknown as Record<string, unknown>;
    return (
      doc.status !== proposal.status ||
      doc.yesCount !== proposal.yesCount ||
      doc.noCount !== proposal.noCount ||
      doc.abstainCount !== proposal.abstainCount ||
      doc.totalMasternodes !== proposal.totalMasternodes ||
      doc.fundingThreshold !== proposal.fundingThreshold
    );
  }

  /**
   * Delete a proposal document
   */
  async deleteProposal(proposalHash: string): Promise<void> {
    const existing = await this.findProposalByHash(proposalHash);
    if (existing) {
      logger.info('Deleting proposal', { hash: proposalHash });
      await this.deleteDocument(DOCUMENT_TYPES.proposal, existing.$id);
    }
  }

  // ==================== Masternode Record Operations ====================

  /**
   * Find a masternode record by proTxHash
   */
  async findMasternodeByProTxHash(proTxHash: string): Promise<PlatformDocument | null> {
    const hashBytes = hexToBytes(proTxHash);

    const documents = await this.queryDocuments(
      DOCUMENT_TYPES.masternodeRecord,
      [['proTxHash', '==', hashBytes]],
      { limit: 1 }
    );

    return documents.length > 0 ? documents[0] : null;
  }

  /**
   * Create or update a masternode record
   */
  async upsertMasternodeRecord(mn: MasternodeData): Promise<{ created: boolean }> {
    const existing = await this.findMasternodeByProTxHash(mn.proTxHash);

    const documentData = {
      proTxHash: hexToBytes(mn.proTxHash),
      votingKeyHash: hexToBytes(mn.votingKeyHash),
      ...(mn.ownerKeyHash && { ownerKeyHash: hexToBytes(mn.ownerKeyHash) }),
      ...(mn.payoutAddress && { payoutAddress: mn.payoutAddress }),
      isEnabled: mn.isEnabled,
      lastUpdatedAt: mn.lastUpdatedAt,
    };

    if (existing) {
      const doc = existing as unknown as Record<string, unknown>;
      if (doc.isEnabled !== mn.isEnabled) {
        logger.debug('Updating masternode record', { proTxHash: mn.proTxHash });

        const revision = (existing as unknown as { $revision?: number }).$revision || 1;
        await this.updateDocument(DOCUMENT_TYPES.masternodeRecord, existing.$id, documentData, revision);
      }
      return { created: false };
    } else {
      logger.debug('Creating new masternode record', { proTxHash: mn.proTxHash });
      await this.createDocument(DOCUMENT_TYPES.masternodeRecord, documentData);
      return { created: true };
    }
  }

  // ==================== Vote Operations ====================

  /**
   * Find a vote by proposal and masternode
   */
  async findVote(proposalHash: string, proTxHash: string): Promise<PlatformDocument | null> {
    const proposalHashBytes = hexToBytes(proposalHash);
    const proTxHashBytes = hexToBytes(proTxHash);

    const documents = await this.queryDocuments(
      DOCUMENT_TYPES.masternodeVote,
      [
        ['proposalHash', '==', proposalHashBytes],
        ['proTxHash', '==', proTxHashBytes],
      ],
      { limit: 1 }
    );

    return documents.length > 0 ? documents[0] : null;
  }

  /**
   * Create or update a vote record
   */
  async upsertMasternodeVote(vote: VoteData): Promise<{ created: boolean }> {
    const existing = await this.findVote(vote.proposalHash, vote.proTxHash);

    const documentData = {
      proposalHash: hexToBytes(vote.proposalHash),
      proTxHash: hexToBytes(vote.proTxHash),
      outcome: vote.outcome,
      timestamp: vote.timestamp,
      ...(vote.voteSignature && { voteSignature: vote.voteSignature }),
    };

    if (existing) {
      const doc = existing as unknown as Record<string, unknown>;
      // Update if outcome or timestamp changed
      if (doc.outcome !== vote.outcome || doc.timestamp !== vote.timestamp) {
        logger.debug('Updating vote', {
          proposalHash: vote.proposalHash,
          proTxHash: vote.proTxHash,
        });

        const revision = (existing as unknown as { $revision?: number }).$revision || 1;
        await this.updateDocument(DOCUMENT_TYPES.masternodeVote, existing.$id, documentData, revision);
      }
      return { created: false };
    } else {
      logger.debug('Creating new vote', {
        proposalHash: vote.proposalHash,
        proTxHash: vote.proTxHash,
      });
      await this.createDocument(DOCUMENT_TYPES.masternodeVote, documentData);
      return { created: true };
    }
  }

  /**
   * Get votes for a proposal
   */
  async getVotesForProposal(proposalHash: string): Promise<PlatformDocument[]> {
    const hashBytes = hexToBytes(proposalHash);

    return this.queryDocuments(
      DOCUMENT_TYPES.masternodeVote,
      [
        ['proposalHash', '==', hashBytes],
        ['outcome', '>', ''], // Required for index
      ],
      { orderBy: [['proposalHash', 'asc'], ['outcome', 'asc'], ['timestamp', 'asc']] }
    );
  }
}

// Singleton instance
let publisherInstance: PlatformPublisher | null = null;

export function getPlatformPublisher(): PlatformPublisher {
  if (!publisherInstance) {
    publisherInstance = new PlatformPublisher();
  }
  return publisherInstance;
}

// Export utility function for other modules
export { bytesToHex };
