export interface ScheduledTask {
    name: string;
    intervalMs: number;
    task: () => Promise<void>;
    immediate?: boolean;
}
export declare class Scheduler {
    private tasks;
    private isStarted;
    /**
     * Register a task to be scheduled
     */
    register(config: ScheduledTask): void;
    /**
     * Unregister a task
     */
    unregister(name: string): void;
    /**
     * Start all registered tasks
     */
    start(): void;
    /**
     * Stop all tasks
     */
    stop(): void;
    /**
     * Run a specific task immediately
     */
    runTask(name: string): Promise<void>;
    /**
     * Get status of all tasks
     */
    getStatus(): Record<string, {
        isRunning: boolean;
        lastRun: number | null;
        lastError: string | null;
        intervalMs: number;
    }>;
}
export declare function getScheduler(): Scheduler;
//# sourceMappingURL=scheduler.d.ts.map