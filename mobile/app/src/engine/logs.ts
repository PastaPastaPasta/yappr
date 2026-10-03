import type { LogLevel } from '@engine/protocol/envelope';

import { recordEngineError } from './errors';
import { redact } from './redact';

export interface LogLine {
  /** Monotonic, for list keys. */
  id: number;
  at: number;
  level: LogLevel;
  /** `engine` for forwarded console lines, `host` for the supervisor's own. */
  source: 'engine' | 'host';
  message: string;
}

/** The diagnostics ring buffer (ENGINE.md §4.7). Nothing leaves the device. */
const CAPACITY = 2000;
/** One line is capped so a dumped object cannot crowd out the rest. */
const MAX_LINE = 2000;

/** Dev builds also print to the Metro console (not in Jest, where it is noise). */
const MIRROR = __DEV__ && process.env.NODE_ENV !== 'test';

let lines: LogLine[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

export function appendLog(level: LogLevel, source: LogLine['source'], message: string): void {
  // Redacted before truncation (a key cut at the limit is still caught), on a bounded slice.
  const redacted = redact(message.slice(0, MAX_LINE + 256));
  const text = redacted.length > MAX_LINE ? `${redacted.slice(0, MAX_LINE)}…` : redacted;
  const line: LogLine = { id: nextId++, at: Date.now(), level, source, message: text };
  lines = [...lines, line].slice(-CAPACITY);
  // Diagnostics' recent errors too: lib logs the reads it recovers from (returning empty) as errors.
  if (level === 'error') recordEngineError(source, text, line.at);
  if (MIRROR && level !== 'debug') {
    const log = level === 'error' ? console.warn : console.log;
    log(`[engine:${source}] ${level} ${text}`);
  }
  listeners.forEach((listener) => listener());
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function getLogs(): readonly LogLine[] {
  return lines;
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
