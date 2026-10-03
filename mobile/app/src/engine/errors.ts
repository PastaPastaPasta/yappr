import { redact } from './redact';

/**
 * The last engine errors, for Engine diagnostics (PRD SET-08: "last 50 engine
 * errors (time, operation, message)"). The supervisor records every engine
 * call that failed, reads included, and every error the engine or the host
 * logged. Only the method path and the redacted message are kept, never a
 * call's arguments, so no keys or message contents. Nothing leaves the device
 * unless the user shares diagnostics.
 */
export interface EngineErrorEntry {
  /** Monotonic, for list keys. */
  id: number;
  at: number;
  /** The engine method (`feed.home`), or `engine` / `host` for a logged error. */
  operation: string;
  message: string;
}

export const ENGINE_ERRORS_CAPACITY = 50;
/** One message is capped so a dumped object cannot crowd out the rest. */
const MAX_MESSAGE = 2000;

let entries: readonly EngineErrorEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

export function recordEngineError(operation: string, message: string, now: number = Date.now()): void {
  // Redacted before truncation (a key cut at the limit is still caught), on a bounded slice.
  const redacted = redact(message.slice(0, MAX_MESSAGE + 256));
  const text = redacted.length > MAX_MESSAGE ? `${redacted.slice(0, MAX_MESSAGE)}…` : redacted;
  entries = [...entries, { id: nextId++, at: now, operation, message: text }].slice(-ENGINE_ERRORS_CAPACITY);
  listeners.forEach((listener) => listener());
}

/** Oldest first. */
export function getEngineErrors(): readonly EngineErrorEntry[] {
  return entries;
}

export function subscribeEngineErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
