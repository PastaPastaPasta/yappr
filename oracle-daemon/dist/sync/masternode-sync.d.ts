import { SyncResult } from '../types';
export declare class MasternodeSync {
    private dashCore;
    private publisher;
    /**
     * Sync masternode list from Dash Core to Platform
     */
    sync(): Promise<SyncResult>;
}
export declare function getMasternodeSync(): MasternodeSync;
//# sourceMappingURL=masternode-sync.d.ts.map