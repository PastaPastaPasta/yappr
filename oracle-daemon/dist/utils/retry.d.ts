export interface RetryOptions {
    attempts: number;
    delayMs: number;
    backoffMultiplier?: number;
    onRetry?: (attempt: number, error: Error) => void;
}
/**
 * Execute an operation with retry logic and exponential backoff
 */
export declare function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T>;
/**
 * Determines if an error is retryable based on common patterns
 */
export declare function isRetryableError(error: unknown): boolean;
//# sourceMappingURL=retry.d.ts.map