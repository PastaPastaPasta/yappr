import { Logger } from 'tslog';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
};

function parseLogLevel(value: string | undefined): LogLevel | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }

  return null;
}

function resolveLogLevel(): LogLevel {
  const explicitLevel = parseLogLevel(process.env.NEXT_PUBLIC_LOG_LEVEL) ?? parseLogLevel(process.env.LOG_LEVEL);
  if (explicitLevel) {
    return explicitLevel;
  }

  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const effectiveLogLevel = resolveLogLevel();

const baseLogger = new Logger<unknown>({
  name: 'yappr',
  minLevel: LOG_LEVEL_PRIORITY[effectiveLogLevel],
});

/**
 * Unwrap WASM error objects from @dashevo/evo-sdk so their message is visible.
 * These objects only expose `__wbg_ptr` as an enumerable property, but have
 * a `.message` getter that contains the actual error string.
 */
function unwrapArg(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    '__wbg_ptr' in value
  ) {
    const wasmObj = value as Record<string, unknown>;
    try {
      const msg = typeof wasmObj.message === 'string' ? wasmObj.message
        : typeof (wasmObj as { getMessage?: () => string }).getMessage === 'function'
          ? (wasmObj as { getMessage: () => string }).getMessage()
          : undefined;
      if (msg) return `[WASM] ${msg}`;
    } catch {
      // Getter may throw if the underlying WASM pointer is freed
    }
    return `[WASM error: ptr=${wasmObj.__wbg_ptr}]`;
  }
  return value;
}

function emit(level: LogLevel, message: unknown, context?: unknown, ...extra: unknown[]): void {
  const parts = context === undefined ? [message, ...extra] : [message, context, ...extra];
  const unwrapped = parts.map(unwrapArg);
  switch (level) {
    case 'debug':
      baseLogger.debug(...unwrapped);
      break;
    case 'info':
      baseLogger.info(...unwrapped);
      break;
    case 'warn':
      baseLogger.warn(...unwrapped);
      break;
    case 'error':
      baseLogger.error(...unwrapped);
      break;
    default:
      break;
  }
}

export const logger = {
  debug(message: unknown, context?: unknown, ...extra: unknown[]): void {
    emit('debug', message, context, ...extra);
  },
  info(message: unknown, context?: unknown, ...extra: unknown[]): void {
    emit('info', message, context, ...extra);
  },
  warn(message: unknown, context?: unknown, ...extra: unknown[]): void {
    emit('warn', message, context, ...extra);
  },
  error(message: unknown, context?: unknown, ...extra: unknown[]): void {
    emit('error', message, context, ...extra);
  },
};
