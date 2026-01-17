"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.getConfig = getConfig;
const dotenv_1 = __importDefault(require("dotenv"));
// Load environment variables from .env file
dotenv_1.default.config();
function getEnvString(key, defaultValue) {
    const value = process.env[key];
    if (value === undefined) {
        if (defaultValue !== undefined) {
            return defaultValue;
        }
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}
function getEnvNumber(key, defaultValue) {
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
function getEnvBoolean(key, defaultValue) {
    const value = process.env[key];
    if (value === undefined) {
        return defaultValue;
    }
    return value.toLowerCase() === 'true' || value === '1';
}
function loadConfig() {
    return {
        dashCore: {
            host: getEnvString('DASH_CORE_HOST', '127.0.0.1'),
            port: getEnvNumber('DASH_CORE_PORT', 9998),
            username: getEnvString('DASH_CORE_USERNAME'),
            password: getEnvString('DASH_CORE_PASSWORD'),
            timeout: getEnvNumber('DASH_CORE_TIMEOUT', 30000),
        },
        platform: {
            network: getEnvString('PLATFORM_NETWORK', 'testnet'),
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
            level: getEnvString('LOG_LEVEL', 'info'),
        },
    };
}
// Singleton config instance
let configInstance = null;
function getConfig() {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}
//# sourceMappingURL=config.js.map