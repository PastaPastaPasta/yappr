import { readErrorMessage as exploreMessage } from '~/features/explore/states';
import { readErrorMessage as homeMessage } from '~/features/home/feed-data';
import { readErrorMessage as notificationsMessage } from '~/features/notifications/read-error';

import {
  GENERIC_MESSAGE,
  isTemporaryReadFailure,
  NOT_SUPPORTED_MESSAGE,
  readErrorMessage,
  UNAVAILABLE_MESSAGE,
} from './read-error';

const coded = (code: string, message = 'failed') => Object.assign(new Error(message), { code });

describe('isTemporaryReadFailure (G-11 "temporarily unavailable", NET-03)', () => {
  it('takes the engine codes for an unreachable Platform or engine, and transport failures by their text', () => {
    expect(isTemporaryReadFailure(coded('ENGINE_BUSY'))).toBe(true);
    expect(isTemporaryReadFailure(coded('RPC_TIMEOUT'))).toBe(true);
    expect(isTemporaryReadFailure({ code: 'TIMEOUT' })).toBe(true);
    expect(isTemporaryReadFailure(new Error('Failed to prefetch quorums: HTTP request error: error sending request'))).toBe(true);
  });

  it('leaves out refusals, failed proofs and a missing session', () => {
    expect(isTemporaryReadFailure(coded('PROOF', 'Proof verification failed'))).toBe(false);
    expect(isTemporaryReadFailure(coded('BAD_CURSOR'))).toBe(false);
    expect(isTemporaryReadFailure(coded('NOT_SIGNED_IN', 'Sign in again after the engine restarted'))).toBe(false);
    expect(isTemporaryReadFailure(null)).toBe(false);
  });
});

it('shows the unavailability copy on every screen for exactly the reads NET-03 retries', () => {
  const temporary = [
    coded('ENGINE_BUSY'),
    coded('TIMEOUT'),
    new Error('fetch failed'),
    coded('INTERNAL', 'Failed to fetch quorum public keys'),
  ];
  for (const error of temporary) {
    expect(readErrorMessage(error)).toBe(UNAVAILABLE_MESSAGE);
    expect(homeMessage(error)).toBe(UNAVAILABLE_MESSAGE);
    expect(exploreMessage(error)).toBe(UNAVAILABLE_MESSAGE);
    expect(notificationsMessage(error)).toBe(UNAVAILABLE_MESSAGE);
  }
  const lasting = [coded('PROOF', 'Proof verification failed'), new Error('boom')];
  for (const error of lasting) {
    expect(readErrorMessage(error)).toBe(GENERIC_MESSAGE);
    expect(homeMessage(error)).toBeUndefined();
    expect(exploreMessage(error)).toBeUndefined();
    expect(notificationsMessage(error)).toBeUndefined();
  }
});

it('says a view the contracts lack is not available yet, never naming the contract (#23)', () => {
  expect(readErrorMessage(coded('NOT_SUPPORTED', 'This contract has no rankings'))).toBe("This isn't available yet.");
  expect(NOT_SUPPORTED_MESSAGE).not.toMatch(/contract|network/i);
});
