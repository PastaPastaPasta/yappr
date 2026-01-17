import { getConfig } from '../config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel;
  private context?: string;

  constructor(context?: string) {
    this.level = getConfig().logging.level;
    this.context = context;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const contextStr = this.context ? `[${this.context}]` : '';
    const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${contextStr} ${message}${dataStr}`;
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, error?: unknown): void {
    if (this.shouldLog('error')) {
      const errorData = error instanceof Error
        ? { message: error.message, stack: error.stack }
        : error;
      console.error(this.formatMessage('error', message, errorData));
    }
  }

  child(context: string): Logger {
    const childLogger = new Logger(
      this.context ? `${this.context}:${context}` : context
    );
    return childLogger;
  }
}

// Create a default logger instance
export const logger = new Logger();

// Factory function for creating contextual loggers
export function createLogger(context: string): Logger {
  return new Logger(context);
}
