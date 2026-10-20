import type { AccountDTO, SessionDTO } from '@engine/api';
import { router } from 'expo-router';

import { useSessionStore } from '~/data/session';
import { addAccount, useAccounts } from '~/features/auth/accounts';
import { confirmSignOut } from '~/features/auth/AccountSwitcher';

import { accountTakenOver, signOutForWallet } from './wallet-messaging';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('~/features/auth/AccountSwitcher', () => ({ confirmSignOut: jest.fn() }));
jest.mock('~/features/auth/accounts', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return { addAccount: jest.fn(async () => undefined), useAccounts: create(() => ({ transition: null, returnTo: null, reauth: null })) };
});

const A = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
const B = '8u9pqhrG1RbkuWvbqQ5WwFgaW2yGkVx2AYBnQ3j5vT1A';
const session = (identityId: string): SessionDTO => ({
  identityId, network: 'testnet', username: null, credits: 0n, hasEncryptionKey: false, method: 'key',
});
const account = (identityId: string, active: boolean): AccountDTO => ({
  identityId, username: null, method: 'key', lastUsedAt: new Date(0), active,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  useAccounts.setState({ transition: null });
});

describe('signOutForWallet (D38 messaging)', () => {
  it('opens the wallet sign-in once the only account is signed out', async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(A), accounts: [account(A, true)] });
    jest.mocked(confirmSignOut).mockImplementation(async () => {
      useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
    });
    signOutForWallet();
    await flush();
    expect(router.push).toHaveBeenCalledWith('/sign-in');
    expect(addAccount).not.toHaveBeenCalled();
  });

  it('waits for the next account to take over, then adds the wallet sign-in beside it', async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(A), accounts: [account(A, true), account(B, false)] });
    // The sign-out resolves with nobody active yet: the switch to B is only queued.
    jest.mocked(confirmSignOut).mockImplementation(async () => {
      useSessionStore.setState({ status: 'signed-out', session: null, accounts: [account(B, false)] });
    });
    signOutForWallet();
    await flush();
    expect(addAccount).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    // B is signed in, but its switch (an engine restart) still runs.
    useAccounts.setState({ transition: { kind: 'switch', label: 'Switching' } });
    useSessionStore.setState({ status: 'signed-in', session: session(B), accounts: [account(B, true)] });
    await flush();
    expect(addAccount).not.toHaveBeenCalled();

    useAccounts.setState({ transition: null });
    await flush();
    expect(addAccount).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('does nothing when the sign-out is cancelled', async () => {
    useSessionStore.setState({ status: 'signed-in', session: session(A), accounts: [account(A, true)] });
    jest.mocked(confirmSignOut).mockResolvedValue(undefined);
    signOutForWallet();
    await flush();
    expect(router.push).not.toHaveBeenCalled();
    expect(addAccount).not.toHaveBeenCalled();
  });
});

describe('accountTakenOver', () => {
  it('gives up when the next account never takes over', async () => {
    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
    await expect(accountTakenOver(B, 10)).rejects.toThrow('did not take over');
  });
});
