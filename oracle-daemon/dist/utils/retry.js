"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRetry = withRetry;
exports.isRetryableError = isRetryableError;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('retry');
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Execute an operation with retry logic and exponential backoff
 */
async function withRetry(operation, options) {
    const { attempts, delayMs, backoffMultiplier = 2, onRetry, } = options;
    let lastError = new Error('No attempts made');
    let delay = delayMs;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await operation();
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (onRetry) {
                onRetry(attempt, lastError);
            }
            else {
                logger.warn(`Attempt ${attempt}/${attempts} failed`, {
                    error: lastError.message,
                    nextDelay: attempt < attempts ? delay : null,
                });
            }
            if (attempt < attempts) {
                await sleep(delay);
                delay *= backoffMultiplier;
            }
        }
    }
    throw lastError;
}
/**
 * Determines if an error is retryable based on common patterns
 */
function isRetryableError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    const message = error.message.toLowerCase();
    // Network/connection errors - retryable
    if (message.includes('econnrefused') ||
        message.includes('econnreset') ||
        message.includes('etimedout') ||
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('socket')) {
        return true;
    }
    // Rate limiting - retryable
    if (message.includes('rate limit') || message.includes('too many requests')) {
        return true;
    }
    // Temporary server errors - retryable
    if (message.includes('503') || message.includes('502') || message.includes('504')) {
        return true;
    }
    // Platform state transition errors that might succeed on retry
    if (message.includes('state transition') && message.includes('timeout')) {
        return true;
    }
    return false;
}
//# sourceMappingURL=retry.js.map