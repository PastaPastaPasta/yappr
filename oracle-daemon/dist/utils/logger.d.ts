export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
declare class Logger {
    private level;
    private context?;
    constructor(context?: string);
    private shouldLog;
    private formatMessage;
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, error?: unknown): void;
    child(context: string): Logger;
}
export declare const logger: Logger;
export declare function createLogger(context: string): Logger;
export {};
//# sourceMappingURL=logger.d.ts.map