"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthChecker = void 0;
exports.getHealthChecker = getHealthChecker;
const express_1 = __importDefault(require("express"));
const dash_core_client_1 = require("../core/dash-core-client");
const scheduler_1 = require("../core/scheduler");
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const logger = (0, logger_1.createLogger)('HealthCheck');
class HealthChecker {
    constructor() {
        this.app = (0, express_1.default)();
        this.server = null;
        this.dashCoreStatus = {
            connected: false,
            lastCheck: 0,
            blockHeight: 0,
        };
        this.platformStatus = {
            connected: false,
            lastCheck: 0,
            credits: 0,
        };
        this.syncStatus = {
            proposals: { timestamp: 0, success: false, count: 0 },
            votes: { timestamp: 0, success: false, count: 0 },
            masternodes: { timestamp: 0, success: false, count: 0 },
        };
        this.setupRoutes();
    }
    setupRoutes() {
        this.app.get('/health', (_req, res) => {
            const status = this.getStatus();
            const httpStatus = status.status === 'healthy' ? 200 :
                status.status === 'degraded' ? 200 : 503;
            res.status(httpStatus).json(status);
        });
        this.app.get('/ready', (_req, res) => {
            const status = this.getStatus();
            if (status.status === 'unhealthy') {
                res.status(503).json({ ready: false });
            }
            else {
                res.status(200).json({ ready: true });
            }
        });
        this.app.get('/metrics', (_req, res) => {
            const scheduler = (0, scheduler_1.getScheduler)();
            const taskStatus = scheduler.getStatus();
            const metrics = {
                dashCore: this.dashCoreStatus,
                platform: this.platformStatus,
                sync: this.syncStatus,
                tasks: taskStatus,
            };
            res.json(metrics);
        });
    }
    /**
     * Start the health check server
     */
    start() {
        const config = (0, config_1.getConfig)();
        if (!config.health.enabled) {
            logger.info('Health check server disabled');
            return;
        }
        this.server = this.app.listen(config.health.port, () => {
            logger.info(`Health check server listening on port ${config.health.port}`);
        });
    }
    /**
     * Stop the health check server
     */
    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
    /**
     * Update Dash Core connection status
     */
    async checkDashCore() {
        try {
            const dashCore = (0, dash_core_client_1.getDashCoreClient)();
            const blockHeight = await dashCore.getBlockCount();
            this.dashCoreStatus = {
                connected: true,
                lastCheck: Date.now(),
                blockHeight,
            };
        }
        catch (error) {
            this.dashCoreStatus = {
                connected: false,
                lastCheck: Date.now(),
                blockHeight: 0,
            };
            logger.warn('Dash Core health check failed', error);
        }
    }
    /**
     * Update Platform connection status
     */
    updatePlatformStatus(connected, credits) {
        this.platformStatus = {
            connected,
            lastCheck: Date.now(),
            credits: credits || this.platformStatus.credits,
        };
    }
    /**
     * Update sync status for a specific sync type
     */
    updateSyncStatus(type, success, count) {
        this.syncStatus[type] = {
            timestamp: Date.now(),
            success,
            count,
        };
    }
    /**
     * Get overall health status
     */
    getStatus() {
        const now = Date.now();
        const staleThreshold = 10 * 60 * 1000; // 10 minutes
        // Check if connections are healthy
        const dashCoreHealthy = this.dashCoreStatus.connected &&
            (now - this.dashCoreStatus.lastCheck < staleThreshold);
        const platformHealthy = this.platformStatus.connected &&
            (now - this.platformStatus.lastCheck < staleThreshold);
        // Check if syncs are recent
        const config = (0, config_1.getConfig)();
        const proposalsSyncHealthy = (now - this.syncStatus.proposals.timestamp < config.sync.proposalIntervalMs * 2) &&
            this.syncStatus.proposals.success;
        const votesSyncHealthy = (now - this.syncStatus.votes.timestamp < config.sync.voteIntervalMs * 2) &&
            this.syncStatus.votes.success;
        const masternodesSyncHealthy = (now - this.syncStatus.masternodes.timestamp < config.sync.masternodeIntervalMs * 2) &&
            this.syncStatus.masternodes.success;
        // Determine overall status
        let status = 'healthy';
        if (!dashCoreHealthy || !platformHealthy) {
            status = 'unhealthy';
        }
        else if (!proposalsSyncHealthy || !votesSyncHealthy || !masternodesSyncHealthy) {
            // Allow degraded status if syncs haven't run yet
            if (this.syncStatus.proposals.timestamp === 0) {
                status = 'degraded';
            }
            else {
                status = 'degraded';
            }
        }
        return {
            status,
            timestamp: now,
            checks: {
                dashCore: this.dashCoreStatus,
                platform: this.platformStatus,
                lastSync: this.syncStatus,
            },
        };
    }
}
exports.HealthChecker = HealthChecker;
// Singleton instance
let healthCheckerInstance = null;
function getHealthChecker() {
    if (!healthCheckerInstance) {
        healthCheckerInstance = new HealthChecker();
    }
    return healthCheckerInstance;
}
//# sourceMappingURL=health-check.js.map