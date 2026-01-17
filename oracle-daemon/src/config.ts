import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export interface OracleConfig {
  // Dash Core RPC Connection
  dashCore: {
    host: string;
    port: number;
    username: string;
    password: string;
    timeout: number;
  };

  // Dash Platform Connection
  platform: {
    network: 'mainnet' | 'testnet';
    identityId: string;
    privateKey: string;
    contractId: string;
  };

  // Sync Configuration
  sync: {
    proposalIntervalMs: number;
    voteIntervalMs: number;
    masternodeIntervalMs: number;
    retryAttempts: number;
    retryDelayMs: number;
  };

  // Health Check
  health: {
    port: number;
    enabled: boolean;
  };

  // Logging
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

function getEnvString(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number`);
  }
  return parsed;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

export function loadConfig(): OracleConfig {
  return {
    dashCore: {
      host: getEnvString('DASH_CORE_HOST', '127.0.0.1'),
      port: getEnvNumber('DASH_CORE_PORT', 9998),
      username: getEnvString('DASH_CORE_USERNAME'),
      password: getEnvString('DASH_CORE_PASSWORD'),
      timeout: getEnvNumber('DASH_CORE_TIMEOUT', 30000),
    },

    platform: {
      network: getEnvString('PLATFORM_NETWORK', 'testnet') as 'mainnet' | 'testnet',
      identityId: getEnvString('PLATFORM_IDENTITY_ID'),
      privateKey: getEnvString('PLATFORM_PRIVATE_KEY'),
      contractId: getEnvString('GOVERNANCE_CONTRACT_ID'),
    },

    sync: {
      proposalIntervalMs: getEnvNumber('SYNC_PROPOSAL_INTERVAL_MS', 300000), // 5 minutes
      voteIntervalMs: getEnvNumber('SYNC_VOTE_INTERVAL_MS', 300000), // 5 minutes
      masternodeIntervalMs: getEnvNumber('SYNC_MASTERNODE_INTERVAL_MS', 3600000), // 1 hour
      retryAttempts: getEnvNumber('SYNC_RETRY_ATTEMPTS', 3),
      retryDelayMs: getEnvNumber('SYNC_RETRY_DELAY_MS', 5000),
    },

    health: {
      port: getEnvNumber('HEALTH_PORT', 8080),
      enabled: getEnvBoolean('HEALTH_ENABLED', true),
    },

    logging: {
      level: getEnvString('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',
    },
  };
}

// Singleton config instance
let configInstance: OracleConfig | null = null;

export function getConfig(): OracleConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
