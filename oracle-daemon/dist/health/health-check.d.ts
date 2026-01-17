import { HealthStatus } from '../types';
export declare class HealthChecker {
    private app;
    private server;
    private dashCoreStatus;
    private platformStatus;
    private syncStatus;
    constructor();
    private setupRoutes;
    /**
     * Start the health check server
     */
    start(): void;
    /**
     * Stop the health check server
     */
    stop(): void;
    /**
     * Update Dash Core connection status
     */
    checkDashCore(): Promise<void>;
    /**
     * Update Platform connection status
     */
    updatePlatformStatus(connected: boolean, credits?: number): void;
    /**
     * Update sync status for a specific sync type
     */
    updateSyncStatus(type: 'proposals' | 'votes' | 'masternodes', success: boolean, count: number): void;
    /**
     * Get overall health status
     */
    getStatus(): HealthStatus;
}
export declare function getHealthChecker(): HealthChecker;
//# sourceMappingURL=health-check.d.ts.map