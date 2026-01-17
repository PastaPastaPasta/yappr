import { SyncResult } from '../types';
export declare class VoteSync {
    private dashCore;
    private publisher;
    /**
     * Sync votes for all active proposals
     */
    sync(): Promise<SyncResult>;
    /**
     * Sync votes for a specific proposal
     */
    private syncVotesForProposal;
}
export declare function getVoteSync(): VoteSync;
//# sourceMappingURL=vote-sync.d.ts.map