import { SyncResult } from '../types';
export declare class ProposalSync {
    private dashCore;
    private publisher;
    /**
     * Sync all proposals from Dash Core to Platform
     */
    sync(): Promise<SyncResult>;
    /**
     * Transform a governance object into proposal data
     */
    private transformProposal;
    /**
     * Extract the public key from the collateral transaction
     * Used for verifying authorship claims
     */
    private extractCollateralPubKey;
}
export declare function getProposalSync(): ProposalSync;
//# sourceMappingURL=proposal-sync.d.ts.map