import { getConfig } from '../config';
import { createLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import {
  GovernanceObject,
  MasternodeListEntry,
  MasternodeCount,
  RawTransaction,
  VoteOutcome,
  VoteRecord,
} from '../types';

const logger = createLogger('DashCoreClient');

interface RpcResponse<T> {
  result: T;
  error: {
    code: number;
    message: string;
  } | null;
  id: string;
}

export class DashCoreClient {
  private host: string;
  private port: number;
  private username: string;
  private password: string;
  private timeout: number;

  constructor() {
    const config = getConfig();
    this.host = config.dashCore.host;
    this.port = config.dashCore.port;
    this.username = config.dashCore.username;
    this.password = config.dashCore.password;
    this.timeout = config.dashCore.timeout;
  }

  /**
   * Make an RPC call to Dash Core
   */
  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
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

      const data = await response.json() as RpcResponse<T>;

      if (data.error) {
        throw new Error(`RPC error ${data.error.code}: ${data.error.message}`);
      }

      return data.result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make an RPC call with retry logic
   */
  private async rpcWithRetry<T>(method: string, params: unknown[] = []): Promise<T> {
    const config = getConfig();
    return withRetry(
      () => this.rpc<T>(method, params),
      {
        attempts: config.sync.retryAttempts,
        delayMs: config.sync.retryDelayMs,
        onRetry: (attempt, error) => {
          logger.warn(`RPC call ${method} failed, retrying`, {
            attempt,
            error: error.message,
          });
        },
      }
    );
  }

  /**
   * Test connection to Dash Core
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.rpc<number>('getblockcount');
      return true;
    } catch (error) {
      logger.error('Connection test failed', error);
      return false;
    }
  }

  /**
   * Get current block height
   */
  async getBlockCount(): Promise<number> {
    return this.rpcWithRetry<number>('getblockcount');
  }

  /**
   * Get block hash for a specific height
   */
  async getBlockHash(height: number): Promise<string> {
    return this.rpcWithRetry<string>('getblockhash', [height]);
  }

  /**
   * Get superblock budget for a specific block height
   */
  async getSuperblockBudget(height: number): Promise<number> {
    return this.rpcWithRetry<number>('getsuperblockbudget', [height]);
  }

  /**
   * Get all governance objects
   */
  async getGovernanceObjects(): Promise<GovernanceObject[]> {
    // gobject list returns an object keyed by hash
    const result = await this.rpcWithRetry<Record<string, GovernanceObject>>('gobject', ['list', 'all']);

    return Object.values(result);
  }

  /**
   * Get a specific governance object by hash
   */
  async getGovernanceObject(hash: string): Promise<GovernanceObject> {
    const result = await this.rpcWithRetry<GovernanceObject>('gobject', ['get', hash]);
    return result;
  }

  /**
   * Get current votes for a governance object
   */
  async getGovernanceVotes(hash: string): Promise<VoteRecord[]> {
    // Returns object keyed by "CTxIn(COutPoint(proTxHash, index), scriptSig=)"
    const result = await this.rpcWithRetry<Record<string, string>>('gobject', ['getcurrentvotes', hash]);

    const votes: VoteRecord[] = [];

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

      let outcome: VoteOutcome;
      if (outcomeStr === 'yes' || outcomeStr === 'funding-yes') {
        outcome = 'yes';
      } else if (outcomeStr === 'no' || outcomeStr === 'funding-no') {
        outcome = 'no';
      } else {
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
  async getMasternodeList(): Promise<MasternodeListEntry[]> {
    // masternode list returns object keyed by proTxHash
    const result = await this.rpcWithRetry<Record<string, MasternodeListEntry>>('masternode', ['list', 'json']);

    return Object.entries(result).map(([proTxHash, mn]) => ({
      ...mn,
      proTxHash: proTxHash.toLowerCase(),
    }));
  }

  /**
   * Get masternode count
   */
  async getMasternodeCount(): Promise<MasternodeCount> {
    const result = await this.rpcWithRetry<MasternodeCount>('masternode', ['count']);
    return result;
  }

  /**
   * Get a raw transaction (for extracting collateral public keys)
   */
  async getRawTransaction(txid: string, verbose: boolean = true): Promise<RawTransaction> {
    return this.rpcWithRetry<RawTransaction>('getrawtransaction', [txid, verbose]);
  }

  /**
   * Get blockchain info
   */
  async getBlockchainInfo(): Promise<{
    chain: string;
    blocks: number;
    headers: number;
    verificationprogress: number;
  }> {
    return this.rpcWithRetry('getblockchaininfo');
  }
}

// Singleton instance
let clientInstance: DashCoreClient | null = null;

export function getDashCoreClient(): DashCoreClient {
  if (!clientInstance) {
    clientInstance = new DashCoreClient();
  }
  return clientInstance;
}
