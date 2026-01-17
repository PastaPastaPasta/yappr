"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const dash_core_client_1 = require("./core/dash-core-client");
const platform_publisher_1 = require("./core/platform-publisher");
const scheduler_1 = require("./core/scheduler");
const proposal_sync_1 = require("./sync/proposal-sync");
const vote_sync_1 = require("./sync/vote-sync");
const masternode_sync_1 = require("./sync/masternode-sync");
const health_check_1 = require("./health/health-check");
const logger_1 = require("./utils/logger");
const logger = (0, logger_1.createLogger)('Main');
async function main() {
    logger.info('Starting Yappr Governance Oracle Daemon');
    try {
        const config = (0, config_1.getConfig)();
        logger.info('Configuration loaded', {
            network: config.platform.network,
            contractId: config.platform.contractId,
            syncIntervals: {
                proposals: config.sync.proposalIntervalMs,
                votes: config.sync.voteIntervalMs,
                masternodes: config.sync.masternodeIntervalMs,
            },
        });
        // Test Dash Core connection
        logger.info('Testing Dash Core connection...');
        const dashCore = (0, dash_core_client_1.getDashCoreClient)();
        const connected = await dashCore.testConnection();
        if (!connected) {
            throw new Error('Could not connect to Dash Core');
        }
        const blockHeight = await dashCore.getBlockCount();
        logger.info('Dash Core connected', { blockHeight });
        // Initialize Platform SDK
        logger.info('Initializing Platform SDK...');
        const publisher = (0, platform_publisher_1.getPlatformPublisher)();
        await publisher.initialize();
        logger.info('Platform SDK initialized');
        // Get sync instances
        const proposalSync = (0, proposal_sync_1.getProposalSync)();
        const voteSync = (0, vote_sync_1.getVoteSync)();
        const masternodeSync = (0, masternode_sync_1.getMasternodeSync)();
        // Get health checker
        const healthChecker = (0, health_check_1.getHealthChecker)();
        // Get scheduler and register tasks
        const scheduler = (0, scheduler_1.getScheduler)();
        // Register proposal sync task
        scheduler.register({
            name: 'proposal-sync',
            intervalMs: config.sync.proposalIntervalMs,
            immediate: true,
            task: async () => {
                const result = await proposalSync.sync();
                healthChecker.updateSyncStatus('proposals', result.errors === 0, result.created + result.updated);
            },
        });
        // Register vote sync task
        scheduler.register({
            name: 'vote-sync',
            intervalMs: config.sync.voteIntervalMs,
            immediate: true,
            task: async () => {
                const result = await voteSync.sync();
                healthChecker.updateSyncStatus('votes', result.errors === 0, result.created + result.updated);
            },
        });
        // Register masternode sync task
        scheduler.register({
            name: 'masternode-sync',
            intervalMs: config.sync.masternodeIntervalMs,
            immediate: true,
            task: async () => {
                const result = await masternodeSync.sync();
                healthChecker.updateSyncStatus('masternodes', result.errors === 0, result.created + result.updated);
            },
        });
        // Register health check task (runs every 30 seconds)
        scheduler.register({
            name: 'health-check',
            intervalMs: 30000,
            immediate: true,
            task: async () => {
                await healthChecker.checkDashCore();
                healthChecker.updatePlatformStatus(true);
            },
        });
        // Start health check server
        healthChecker.start();
        // Start scheduler
        scheduler.start();
        logger.info('Oracle daemon started successfully');
        // Handle graceful shutdown
        const shutdown = async () => {
            logger.info('Shutting down...');
            scheduler.stop();
            healthChecker.stop();
            await publisher.disconnect();
            logger.info('Shutdown complete');
            process.exit(0);
        };
        process.on('SIGINT', () => {
            void shutdown();
        });
        process.on('SIGTERM', () => {
            void shutdown();
        });
    }
    catch (error) {
        logger.error('Failed to start oracle daemon', error);
        process.exit(1);
    }
}
// Run main
void main();
//# sourceMappingURL=index.js.map