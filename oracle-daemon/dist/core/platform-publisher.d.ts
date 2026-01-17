import { bytesToHex } from '../utils/hash-utils';
import { ProposalData, MasternodeData, VoteData, PlatformDocument } from '../types';
export declare class PlatformPublisher {
    private sdk;
    private contractId;
    private identityId;
    private privateKey;
    constructor();
    /**
     * Initialize the SDK connection
     */
    initialize(): Promise<void>;
    /**
     * Disconnect from Platform
     */
    disconnect(): Promise<void>;
    /**
     * Ensure SDK is initialized
     */
    private ensureInitialized;
    /**
     * Generate entropy for state transitions
     */
    private generateEntropy;
    /**
     * Query documents by type and conditions
     */
    queryDocuments(documentType: string, where: Array<[string, string, unknown]>, options?: {
        limit?: number;
        orderBy?: Array<[string, string]>;
    }): Promise<PlatformDocument[]>;
    /**
     * Create a new document
     */
    private createDocument;
    /**
     * Update an existing document
     */
    private updateDocument;
    /**
     * Delete a document
     */
    private deleteDocument;
    /**
     * Find a proposal by its governance object hash
     */
    findProposalByHash(proposalHash: string): Promise<PlatformDocument | null>;
    /**
     * Get all proposals
     */
    getAllProposals(): Promise<PlatformDocument[]>;
    /**
     * Get proposals by status
     */
    getProposalsByStatus(status: string): Promise<PlatformDocument[]>;
    /**
     * Create or update a proposal document
     */
    upsertProposal(proposal: ProposalData): Promise<{
        created: boolean;
    }>;
    /**
     * Check if proposal data has changed (comparing relevant fields)
     */
    private hasProposalChanged;
    /**
     * Delete a proposal document
     */
    deleteProposal(proposalHash: string): Promise<void>;
    /**
     * Find a masternode record by proTxHash
     */
    findMasternodeByProTxHash(proTxHash: string): Promise<PlatformDocument | null>;
    /**
     * Create or update a masternode record
     */
    upsertMasternodeRecord(mn: MasternodeData): Promise<{
        created: boolean;
    }>;
    /**
     * Find a vote by proposal and masternode
     */
    findVote(proposalHash: string, proTxHash: string): Promise<PlatformDocument | null>;
    /**
     * Create or update a vote record
     */
    upsertMasternodeVote(vote: VoteData): Promise<{
        created: boolean;
    }>;
    /**
     * Get votes for a proposal
     */
    getVotesForProposal(proposalHash: string): Promise<PlatformDocument[]>;
}
export declare function getPlatformPublisher(): PlatformPublisher;
export { bytesToHex };
//# sourceMappingURL=platform-publisher.d.ts.map