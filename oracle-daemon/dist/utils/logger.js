"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.createLogger = createLogger;
const config_1 = require("../config");
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
class Logger {
    constructor(context) {
        this.level = (0, config_1.getConfig)().logging.level;
        this.context = context;
    }
    shouldLog(level) {
        return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
    }
    formatMessage(level, message, data) {
        const timestamp = new Date().toISOString();
        const contextStr = this.context ? `[${this.context}]` : '';
        const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
        return `${timestamp} ${level.toUpperCase().padEnd(5)} ${contextStr} ${message}${dataStr}`;
    }
    debug(message, data) {
        if (this.shouldLog('debug')) {
            console.log(this.formatMessage('debug', message, data));
        }
    }
    info(message, data) {
        if (this.shouldLog('info')) {
            console.log(this.formatMessage('info', message, data));
        }
    }
    warn(message, data) {
        if (this.shouldLog('warn')) {
            console.warn(this.formatMessage('warn', message, data));
        }
    }
    error(message, error) {
        if (this.shouldLog('error')) {
            const errorData = error instanceof Error
                ? { message: error.message, stack: error.stack }
                : error;
            console.error(this.formatMessage('error', message, errorData));
        }
    }
    child(context) {
        const childLogger = new Logger(this.context ? `${this.context}:${context}` : context);
        return childLogger;
    }
}
// Create a default logger instance
exports.logger = new Logger();
// Factory function for creating contextual loggers
function createLogger(context) {
    return new Logger(context);
}
//# sourceMappingURL=logger.js.map