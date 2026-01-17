"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashCoreClient = void 0;
exports.getDashCoreClient = getDashCoreClient;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const retry_1 = require("../utils/retry");
const logger = (0, logger_1.createLogger)('DashCoreClient');
class DashCoreClient {
    constructor() {
        const config = (0, config_1.getConfig)();
        this.host = config.dashCore.host;
        this.port = config.dashCore.port;
        this.username = config.dashCore.username;
        this.password = config.dashCore.password;
        this.timeout = config.dashCore.timeout;
    }
    /**
     * Make an RPC call to Dash Core
     */
    async rpc(method, params = []) {
        const url = `http://${this.host}:${this.port}`;
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`,
                },
                body: JSON.stringify({
                    jsonrpc: '1.0',
                    id: Date.now().toString(),
                    method,
                    params,
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
            }
            const data = await response.json();
            if (data.error) {
                throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
            }
            return data.result;
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    /**
     * Make an RPC call with retry logic
     */
    async rpcWithRetry(method, params = []) {
        const config = (0, config_1.getConfig)();
        return (0, retry_1.withRetry)(() => this.rpc(method, params), {
            attempts: config.sync.retryAttempts,
            delayMs: config.sync.retryDelayMs,
            onRetry: (attempt, error) => {
                logger.warn(`RPC call ${method} failed, retrying`, {
                    attempt,
                    error: error.message,
                });
            },
        });
    }
    /**
     * Test connection to Dash Core
     */
    async testConnection() {
        try {
            await this.rpc('getblockcount');
            return true;
        }
        catch (error) {
            logger.error('Connection test failed', error);
            return false;
        }
    }
    /**
     * Get current block height
     */
    async getBlockCount() {
        return this.rpcWithRetry('getblockcount');
    }
    /**
     * Get block hash for a specific height
     */
    async getBlockHash(height) {
        return this.rpcWithRetry('getblockhash', [height]);
    }
    /**
     * Get superblock budget for a specific block height
     */
    async getSuperblockBudget(height) {
        return this.rpcWithRetry('getsuperblockbudget', [height]);
    }
    /**
     * Get all governance objects
     */
    async getGovernanceObjects() {
        // gobject list returns an object keyed by hash
        const result = await this.rpcWithRetry('gobject', ['list', 'all']);
        return Object.values(result);
    }
    /**
     * Get a specific governance object by hash
     */
    async getGovernanceObject(hash) {
        const result = await this.rpcWithRetry('gobject', ['get', hash]);
        return result;
    }
    /**
     * Get current votes for a governance object
     */
    async getGovernanceVotes(hash) {
        // Returns object keyed by "CTxIn(COutPoint(proTxHash, index), scriptSig=)"
        const result = await this.rpcWithRetry('gobject', ['getcurrentvotes', hash]);
        const votes = [];
        for (const [key, value] of Object.entries(result)) {
            // Parse key: "CTxIn(COutPoint(abc123...def456, 0), scriptSig=)"
            const proTxMatch = key.match(/COutPoint\(([a-f0-9]{64})/i);
            if (!proTxMatch) {
                logger.warn('Could not parse vote key', { key });
                continue;
            }
            // Parse value: "timestamp:outcome:voteHash"
            // or sometimes just "timestamp:outcome"
            const valueParts = value.split(':');
            if (valueParts.length < 2) {
                logger.warn('Could not parse vote value', { value });
                continue;
            }
            const timestamp = parseInt(valueParts[0], 10);
            const outcomeStr = valueParts[1].toLowerCase();
            let outcome;
            if (outcomeStr === 'yes' || outcomeStr === 'funding-yes') {
                outcome = 'yes';
            }
            else if (outcomeStr === 'no' || outcomeStr === 'funding-no') {
                outcome = 'no';
            }
            else {
                outcome = 'abstain';
            }
            votes.push({
                proTxHash: proTxMatch[1].toLowerCase(),
                outcome,
                timestamp,
                voteHash: valueParts[2],
            });
        }
        return votes;
    }
    /**
     * Get the full masternode list
     */
    async getMasternodeList() {
        // masternode list returns object keyed by proTxHash
        const result = await this.rpcWithRetry('masternode', ['list', 'json']);
        return Object.entries(result).map(([proTxHash, mn]) => ({
            ...mn,
            proTxHash: proTxHash.toLowerCase(),
        }));
    }
    /**
     * Get masternode count
     */
    async getMasternodeCount() {
        const result = await this.rpcWithRetry('masternode', ['count']);
        return result;
    }
    /**
     * Get a raw transaction (for extracting collateral public keys)
     */
    async getRawTransaction(txid, verbose = true) {
        return this.rpcWithRetry('getrawtransaction', [txid, verbose]);
    }
    /**
     * Get blockchain info
     */
    async getBlockchainInfo() {
        return this.rpcWithRetry('getblockchaininfo');
    }
}
exports.DashCoreClient = DashCoreClient;
// Singleton instance
let clientInstance = null;
function getDashCoreClient() {
    if (!clientInstance) {
        clientInstance = new DashCoreClient();
    }
    return clientInstance;
}
//# sourceMappingURL=dash-core-client.js.map