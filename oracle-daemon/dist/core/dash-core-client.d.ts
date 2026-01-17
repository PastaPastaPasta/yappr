import { GovernanceObject, MasternodeListEntry, MasternodeCount, RawTransaction, VoteRecord } from '../types';
export declare class DashCoreClient {
    private host;
    private port;
    private username;
    private password;
    private timeout;
    constructor();
    /**
     * Make an RPC call to Dash Core
     */
    private rpc;
    /**
     * Make an RPC call with retry logic
     */
    private rpcWithRetry;
    /**
     * Test connection to Dash Core
     */
    testConnection(): Promise<boolean>;
    /**
     * Get current block height
     */
    getBlockCount(): Promise<number>;
    /**
     * Get block hash for a specific height
     */
    getBlockHash(height: number): Promise<string>;
    /**
     * Get superblock budget for a specific block height
     */
    getSuperblockBudget(height: number): Promise<number>;
    /**
     * Get all governance objects
     */
    getGovernanceObjects(): Promise<GovernanceObject[]>;
    /**
     * Get a specific governance object by hash
     */
    getGovernanceObject(hash: string): Promise<GovernanceObject>;
    /**
     * Get current votes for a governance object
     */
    getGovernanceVotes(hash: string): Promise<VoteRecord[]>;
    /**
     * Get the full masternode list
     */
    getMasternodeList(): Promise<MasternodeListEntry[]>;
    /**
     * Get masternode count
     */
    getMasternodeCount(): Promise<MasternodeCount>;
    /**
     * Get a raw transaction (for extracting collateral public keys)
     */
    getRawTransaction(txid: string, verbose?: boolean): Promise<RawTransaction>;
    /**
     * Get blockchain info
     */
    getBlockchainInfo(): Promise<{
        chain: string;
        blocks: number;
        headers: number;
        verificationprogress: number;
    }>;
}
export declare function getDashCoreClient(): DashCoreClient;
//# sourceMappingURL=dash-core-client.d.ts.map