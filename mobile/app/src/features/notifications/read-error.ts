/** UX_SPEC §5.12, `lib/error-utils.ts`. */
export const UNAVAILABLE_MESSAGE = 'Dash Platform is temporarily unavailable. Please try again in a few moments.';
const NETWORK_MESSAGE = 'Network error. Please check your connection and try again.';
const SESSION_MESSAGE = 'Your session has expired. Please sign in again.';

const UNAVAILABLE_CODES = new Set([
  'ENGINE_UNAVAILABLE',
  'ENGINE_BUSY',
  'ENGINE_RESTARTED',
  'ENGINE_DISCONNECTED',
  'ENGINE_HELLO_TIMEOUT',
  'RPC_TIMEOUT',
  'UNAVAILABLE',
  'TIMEOUT',
]);

/**
 * The categorized copy for a failed read (PRD G-11), from the engine's error
 * code; undefined when there is nothing specific to say, and the error state
 * shows only "Something went wrong".
 */
export function readErrorMessage(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return undefined;
  if (UNAVAILABLE_CODES.has(code)) return UNAVAILABLE_MESSAGE;
  if (code === 'NETWORK') return NETWORK_MESSAGE;
  if (code === 'NOT_SIGNED_IN') return SESSION_MESSAGE;
  return undefined;
}
