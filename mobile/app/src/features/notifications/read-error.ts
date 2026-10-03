import { isTemporaryReadFailure } from '~/data/read-error';

/** UX_SPEC §5.12, `lib/error-utils.ts`. */
export const UNAVAILABLE_MESSAGE = 'Dash Platform is temporarily unavailable. Please try again in a few moments.';
const NETWORK_MESSAGE = 'Network error. Please check your connection and try again.';
const SESSION_MESSAGE = 'Your session has expired. Please sign in again.';

/**
 * The categorized copy for a failed read (PRD G-11): the unavailability copy
 * for `isTemporaryReadFailure`, which also decides NET-03's retry; undefined
 * when there is nothing specific to say, and the error state shows only
 * "Something went wrong".
 */
export function readErrorMessage(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'NOT_SIGNED_IN') return SESSION_MESSAGE;
  if (code === 'NETWORK') return NETWORK_MESSAGE;
  return isTemporaryReadFailure(error) ? UNAVAILABLE_MESSAGE : undefined;
}
