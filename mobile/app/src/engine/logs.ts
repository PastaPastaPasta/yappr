import type { LogLevel } from '@engine/protocol/envelope';

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
  const text = redact(message.length > MAX_LINE ? `${message.slice(0, MAX_LINE)}…` : message);
  const line: LogLine = { id: nextId++, at: Date.now(), level, source, message: text };
  lines = lines.length >= CAPACITY ? [...lines.slice(lines.length - CAPACITY + 1), line] : [...lines, line];
  if (MIRROR && level !== 'debug') {
    const log = level === 'error' ? console.warn : console.log;
    log(`[engine:${source}] ${level} ${text}`);
  }
  listeners.forEach((listener) => listener());
}

export function getLogs(): readonly LogLine[] {
  return lines;
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
