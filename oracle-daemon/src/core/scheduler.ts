import { createLogger } from '../utils/logger.js';

const logger = createLogger('Scheduler');

export interface ScheduledTask {
  name: string;
  intervalMs: number;
  task: () => Promise<void>;
  immediate?: boolean;
}

interface RunningTask {
  name: string;
  intervalMs: number;
  task: () => Promise<void>;
  timerId: NodeJS.Timeout | null;
  isRunning: boolean;
  lastRun: number | null;
  lastError: Error | null;
}

export class Scheduler {
  private tasks: Map<string, RunningTask> = new Map();
  private isStarted: boolean = false;

  /**
   * Register a task to be scheduled
   */
  register(config: ScheduledTask): void {
    if (this.tasks.has(config.name)) {
      logger.warn(`Task ${config.name} already registered, replacing`);
      this.unregister(config.name);
    }

    this.tasks.set(config.name, {
      name: config.name,
      intervalMs: config.intervalMs,
      task: config.task,
      timerId: null,
      isRunning: false,
      lastRun: null,
      lastError: null,
    });

    logger.info(`Task registered: ${config.name}`, {
      intervalMs: config.intervalMs,
      immediate: config.immediate,
    });

    // If scheduler is already started and immediate flag is set, run now
    if (this.isStarted && config.immediate) {
      void this.runTask(config.name);
    }
  }

  /**
   * Unregister a task
   */
  unregister(name: string): void {
    const task = this.tasks.get(name);
    if (task) {
      if (task.timerId) {
        clearInterval(task.timerId);
      }
      this.tasks.delete(name);
      logger.info(`Task unregistered: ${name}`);
    }
  }

  /**
   * Start all registered tasks
   */
  start(): void {
    if (this.isStarted) {
      logger.warn('Scheduler already started');
      return;
    }

    logger.info('Starting scheduler', { taskCount: this.tasks.size });
    this.isStarted = true;

    for (const [name, task] of this.tasks) {
      // Start the interval timer
      task.timerId = setInterval(() => {
        void this.runTask(name);
      }, task.intervalMs);

      // Run immediately on start
      void this.runTask(name);
    }
  }

  /**
   * Stop all tasks
   */
  stop(): void {
    if (!this.isStarted) {
      return;
    }

    logger.info('Stopping scheduler');
    this.isStarted = false;

    for (const task of this.tasks.values()) {
      if (task.timerId) {
        clearInterval(task.timerId);
        task.timerId = null;
      }
    }
  }

  /**
   * Run a specific task immediately
   */
  async runTask(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (!task) {
      logger.warn(`Task not found: ${name}`);
      return;
    }

    if (task.isRunning) {
      logger.debug(`Task ${name} is already running, skipping`);
      return;
    }

    task.isRunning = true;
    const startTime = Date.now();

    try {
      logger.debug(`Running task: ${name}`);
      await task.task();
      task.lastRun = Date.now();
      task.lastError = null;
      logger.debug(`Task ${name} completed`, {
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      task.lastError = error instanceof Error ? error : new Error(String(error));
      logger.error(`Task ${name} failed`, error);
    } finally {
      task.isRunning = false;
    }
  }

  /**
   * Get status of all tasks
   */
  getStatus(): Record<string, {
    isRunning: boolean;
    lastRun: number | null;
    lastError: string | null;
    intervalMs: number;
  }> {
    const status: Record<string, {
      isRunning: boolean;
      lastRun: number | null;
      lastError: string | null;
      intervalMs: number;
    }> = {};

    for (const [name, task] of this.tasks) {
      status[name] = {
        isRunning: task.isRunning,
        lastRun: task.lastRun,
        lastError: task.lastError?.message || null,
        intervalMs: task.intervalMs,
      };
    }

    return status;
  }
}

// Singleton instance
let schedulerInstance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler();
  }
  return schedulerInstance;
}
