import { errorCode } from '~/data/writes';

import { copy } from './copy';

/** Engine codes that mean "we could not reach Dash Platform or the engine", not "you did something wrong". */
const TRANSIENT_CODES = new Set([
  'RPC_TIMEOUT',
  'ENGINE_RESTARTED',
  'ENGINE_DISCONNECTED',
  'ENGINE_HELLO_TIMEOUT',
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMITED',
]);
/** `no available addresses`: the SDK ran out of DAPI nodes to try (`… to use`, `… to retry`). */
const TRANSIENT_MESSAGE = /network|timed? ?out|timeout|unavailable|fetch|connect|quorum|no available addresses|503|504|502/i;

/** A failure worth "Try again" with the same input, as opposed to one the input causes. */
export function isTransient(error: unknown): boolean {
  const code = errorCode(error);
  if (code && TRANSIENT_CODES.has(code)) return true;
  return !code && error instanceof Error && TRANSIENT_MESSAGE.test(error.message);
}

const message = (error: unknown) => (error instanceof Error ? error.message : '');

/**
 * The line under the private-key field (PRD AUTH-08, UX_SPEC §5.1 key.*).
 * KEY_NOT_ON_IDENTITY carries lib's own reason (a MASTER key, a disabled
 * key), which is user-facing text already.
 */
export function keyErrorText(error: unknown): string {
  switch (errorCode(error)) {
    case 'KEY_INVALID':
      return copy.key.invalid;
    case 'KEY_WRONG_NETWORK':
      return copy.key.otherNetwork;
    case 'IDENTITY_NOT_FOUND':
      return copy.key.noIdentity;
    case 'KEY_NOT_ON_IDENTITY':
      return message(error) || copy.key.mismatch;
    case 'BAD_REQUEST':
      return copy.signin.alreadySignedIn;
    default:
      return isTransient(error) ? copy.signin.unavailable : message(error) || copy.signin.unavailable;
  }
}

/** Why a wallet sign-in failed (PRD AUTH-07), for the "Sign-in failed" state. */
export function walletErrorText(error: unknown, network: string): string {
  const code = errorCode(error);
  const text = message(error);
  if (code === 'BAD_REQUEST' && /signed in/i.test(text)) return copy.signin.alreadySignedIn;
  if (/different network|wrong network|network mismatch/i.test(text)) return copy.signin.wrongNetwork(network);
  if (code === 'IDENTITY_NOT_FOUND' || /identity.*not found|no identity/i.test(text)) return copy.signin.noIdentity(network);
  if (isTransient(error)) return copy.signin.unavailable;
  return text || copy.signin.unavailable;
}
