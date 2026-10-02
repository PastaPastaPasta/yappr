import type { SessionDTO, WriteTicket } from '@engine/api';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { syncStorage } from '~/state/storage';

import { SignInPromptHost, promptSignIn, requireAuth, useSignInPrompt } from './require-auth';
import { startSessionSync, useSessionStore } from './session';
import {
  SESSION_EXPIRED_MESSAGE,
  clearSessionExpired,
  failedForSession,
  isSessionExpired,
  markSessionExpired,
  setReauthHandler,
  useExpiredSessions,
} from './session-expiry';
import { fakeEngine } from './testing/fake-engine';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const STORAGE_KEY = 'yappr.session.expired';

const session = (identityId: string): SessionDTO => ({
  identityId,
  network: 'devnet',
  username: null,
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
});

const failure = (op: WriteTicket['op'], code: string) =>
  ({ op, error: { code, consensusCode: null, outcome: 'refused', retryable: false, userMessage: 'x' } }) as Pick<
    WriteTicket,
    'op' | 'error'
  >;

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  syncStorage.removeItem(STORAGE_KEY);
  syncStorage.removeItem('yappr.session.identity');
  useExpiredSessions.setState({ ids: [] });
  useSessionStore.setState({ status: 'signed-in', session: session('alice'), accounts: [] });
  useSignInPrompt.setState({ open: false, reauth: null });
  fakeEngine.method('session.accounts').mockResolvedValue([]);
});

describe('which failures mean the session expired (AUTH-14)', () => {
  it('counts a key Platform refused on any write, and a missing key outside Messages', () => {
    expect(failedForSession(failure('like', 'KEY_REVOKED'))).toBe(true);
    expect(failedForSession(failure('dm.send', 'KEY_REVOKED'))).toBe(true);
    expect(failedForSession(failure('post.publish', 'NO_KEY'))).toBe(true);
    // Messages' NO_KEY is the device's encryption key (the unlock sheet), not the session.
    expect(failedForSession(failure('dm.send', 'NO_KEY'))).toBe(false);
    expect(failedForSession(failure('dm.group', 'NO_KEY'))).toBe(false);
    expect(failedForSession(failure('like', 'FEE_UNPAYABLE'))).toBe(false);
    expect(failedForSession({ op: 'like', error: null })).toBe(false);
  });
});

describe('the "Sign in again" mark', () => {
  it('persists across launches, and clears', () => {
    markSessionExpired('alice');
    markSessionExpired('alice');
    expect(JSON.parse(syncStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(['alice']);

    // A new launch reads it back.
    jest.isolateModules(() => {
      const fresh = jest.requireActual<typeof import('./session-expiry')>('./session-expiry');
      expect(fresh.isSessionExpired('alice')).toBe(true);
      expect(fresh.isSessionExpired('bob')).toBe(false);
    });

    clearSessionExpired('alice');
    expect(isSessionExpired('alice')).toBe(false);
    expect(syncStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('ignores a corrupt stored value', () => {
    syncStorage.setItem(STORAGE_KEY, '{nope');
    jest.isolateModules(() => {
      const fresh = jest.requireActual<typeof import('./session-expiry')>('./session-expiry');
      expect(fresh.useExpiredSessions.getState().ids).toEqual([]);
    });
  });

  it('clears on a fresh sign-in of that account, not on a switch back to it or a restore', async () => {
    markSessionExpired('alice');
    fakeEngine.method('session.current').mockResolvedValue(session('alice'));
    const stop = startSessionSync();
    try {
      await act(async () => fakeEngine.emit('session.changed', { session: session('alice'), reason: 'switched' }));
      await act(async () => fakeEngine.emit('session.changed', { session: session('alice'), reason: 'restored' }));
      expect(isSessionExpired('alice')).toBe(true);

      await act(async () => fakeEngine.emit('session.changed', { session: session('bob'), reason: 'signed-in' }));
      expect(isSessionExpired('alice')).toBe(true);
      await act(async () => fakeEngine.emit('session.changed', { session: session('alice'), reason: 'signed-in' }));
      expect(isSessionExpired('alice')).toBe(false);
    } finally {
      stop();
    }
  });
});

describe('write controls of an account marked "Sign in again"', () => {
  it('open its sign-in instead of running the write', () => {
    const action = jest.fn();
    markSessionExpired('alice');
    requireAuth(action);
    expect(action).not.toHaveBeenCalled();
    expect(useSignInPrompt.getState()).toEqual({ open: true, reauth: 'alice' });

    // Another account is unaffected.
    useSignInPrompt.setState({ open: false, reauth: null });
    useSessionStore.setState({ session: session('bob') });
    requireAuth(action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(useSignInPrompt.getState().open).toBe(false);
  });

  it('count the last account while the engine restores', () => {
    const action = jest.fn();
    markSessionExpired('alice');
    useSessionStore.setState({ status: 'unknown', session: null });
    syncStorage.setItem('yappr.session.identity', 'alice');
    requireAuth(action);
    expect(action).not.toHaveBeenCalled();
    expect(useSignInPrompt.getState().reauth).toBe('alice');
  });

  it('still ask a signed-out user to sign in, not to sign in again', () => {
    markSessionExpired('alice');
    useSessionStore.setState({ status: 'signed-out', session: null });
    requireAuth(jest.fn());
    expect(useSignInPrompt.getState()).toEqual({ open: true, reauth: null });
  });

  it('"Sign in again" in the sheet opens the sign-in flow for that account', () => {
    const handler = jest.fn();
    const unregister = setReauthHandler(handler);
    try {
      render(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
          <SignInPromptHost />
        </SafeAreaProvider>,
      );
      act(() => promptSignIn('alice'));
      // The title and the button.
      expect(screen.getAllByText('Sign in again')).toHaveLength(2);
      expect(screen.getByText(`${SESSION_EXPIRED_MESSAGE} You can keep browsing in the meantime.`)).toBeTruthy();
      fireEvent.press(screen.getByTestId('sign-in-prompt-sign-in'));
      expect(handler).toHaveBeenCalledWith('alice');
      expect(router.push).not.toHaveBeenCalled();
      expect(useSignInPrompt.getState().open).toBe(false);
    } finally {
      unregister();
    }
  });
});
