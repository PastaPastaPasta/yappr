import { getConfig } from './config';
import { getDashCoreClient } from './core/dash-core-client';
import { getPlatformPublisher } from './core/platform-publisher';
import { getScheduler } from './core/scheduler';
import { getProposalSync } from './sync/proposal-sync';
import { getVoteSync } from './sync/vote-sync';
import { getMasternodeSync } from './sync/masternode-sync';
import { getHealthChecker } from './health/health-check';
import { createLogger } from './utils/logger';

const logger = createLogger('Main');

async function main(): Promise<void> {
  logger.info('Starting Yappr Governance Oracle Daemon');

  try {
    const config = getConfig();
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
    const dashCore = getDashCoreClient();
    const connected = await dashCore.testConnection();
    if (!connected) {
      throw new Error('Could not connect to Dash Core');
    }

    const blockHeight = await dashCore.getBlockCount();
    logger.info('Dash Core connected', { blockHeight });

    // Initialize Platform SDK
    logger.info('Initializing Platform SDK...');
    const publisher = getPlatformPublisher();
    await publisher.initialize();
    logger.info('Platform SDK initialized');

    // Get sync instances
    const proposalSync = getProposalSync();
    const voteSync = getVoteSync();
    const masternodeSync = getMasternodeSync();

    // Get health checker
    const healthChecker = getHealthChecker();

    // Get scheduler and register tasks
    const scheduler = getScheduler();

    // Register proposal sync task
    scheduler.register({
      name: 'proposal-sync',
      intervalMs: config.sync.proposalIntervalMs,
      immediate: true,
      task: async () => {
        const result = await proposalSync.sync();
        healthChecker.updateSyncStatus(
          'proposals',
          result.errors === 0,
          result.created + result.updated
        );
      },
    });

    // Register vote sync task
    scheduler.register({
      name: 'vote-sync',
      intervalMs: config.sync.voteIntervalMs,
      immediate: true,
      task: async () => {
        const result = await voteSync.sync();
        healthChecker.updateSyncStatus(
          'votes',
          result.errors === 0,
          result.created + result.updated
        );
      },
    });

    // Register masternode sync task
    scheduler.register({
      name: 'masternode-sync',
      intervalMs: config.sync.masternodeIntervalMs,
      immediate: true,
      task: async () => {
        const result = await masternodeSync.sync();
        healthChecker.updateSyncStatus(
          'masternodes',
          result.errors === 0,
          result.created + result.updated
        );
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
    const shutdown = async (): Promise<void> => {
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
  } catch (error) {
    logger.error('Failed to start oracle daemon', error);
    process.exit(1);
  }
}

// Run main
void main();
