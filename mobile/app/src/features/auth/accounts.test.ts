import type { AccountDTO, SessionDTO } from '@engine/api';
import { router } from 'expo-router';

import { useSessionStore } from '~/data/session';
import { engineModule, fakeEngine } from '~/data/testing/fake-engine';
import { useToastStore } from '~/ui/toast';

import { accountName, addAccount, returnFromAddAccount, signOutAccount, switchAccount, useAccounts } from './accounts';
import { useOnboarding } from './onboarding';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const session = (identityId: string, username: string | null = null): SessionDTO => ({
  identityId,
  network: 'devnet',
  username,
  credits: 1n,
  hasEncryptionKey: false,
  method: 'key',
});
const account = (identityId: string, active = false): AccountDTO => ({
  identityId,
  username: `${identityId}.dash`,
  method: 'key',
  lastUsedAt: new Date(0),
  active,
});
const restart = engineModule.engineSupervisor.restart as jest.Mock;
/** What the next engine boot's session restore reports. */
const bootsAs = (next: SessionDTO | null) =>
  restart.mockImplementation(() => {
    queueMicrotask(() => useSessionStore.setState({ status: next ? 'signed-in' : 'signed-out', session: next }));
  });

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  useSessionStore.setState({ status: 'signed-in', session: session('alice'), accounts: [account('alice', true), account('bob')] });
  useAccounts.setState({ transition: null, returnTo: null });
  useToastStore.setState({ current: null });
  useOnboarding.setState({ welcomed: true });
});

it('names accounts by their handle without the .dash suffix', () => {
  expect(accountName({ identityId: 'x', username: 'alice.dash' })).toBe('@alice');
});

it('switches accounts as a controlled engine restart, showing progress (AUTH-10)', async () => {
  fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
  bootsAs(session('bob'));

  const switching = switchAccount({ identityId: 'bob', username: 'bob' });
  expect(useAccounts.getState().transition).toEqual({ kind: 'switch', label: 'Switching to @bob…' });

  await expect(switching).resolves.toBe(true);
  expect(fakeEngine.method('session.switchAccount')).toHaveBeenCalledWith('bob');
  expect(restart).toHaveBeenCalledTimes(1);
  expect(useAccounts.getState().transition).toBeNull();
  expect(useToastStore.getState().current?.message).toBe('Switched to @bob');
});

it('reports a switch whose account did not come back', async () => {
  fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
  bootsAs(null);

  await expect(switchAccount({ identityId: 'bob', username: 'bob' })).resolves.toBe(false);
  expect(useToastStore.getState().current?.message).toBe("Couldn't switch accounts. Please try again.");
});

it('adds an account: parks the current one, restarts signed out, opens sign-in, and returns if abandoned', async () => {
  fakeEngine.method('session.prepareAddAccount').mockResolvedValue(undefined);
  bootsAs(null);

  await addAccount();
  expect(router.push).toHaveBeenCalledWith('/sign-in');
  expect(useAccounts.getState().returnTo).toBe('alice');

  fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
  bootsAs(session('alice'));
  returnFromAddAccount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fakeEngine.method('session.switchAccount')).toHaveBeenCalledWith('alice');
  expect(useAccounts.getState().returnTo).toBeNull();
});

it('signs out the active account and moves to the next one (AUTH-11)', async () => {
  fakeEngine.method('session.signOut').mockResolvedValue(undefined);
  fakeEngine.method('session.accounts').mockResolvedValue([account('bob')]);
  fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
  bootsAs(session('bob'));

  await expect(signOutAccount('alice')).resolves.toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fakeEngine.method('session.signOut')).toHaveBeenCalledWith({ identityId: 'alice' });
  expect(fakeEngine.method('session.switchAccount')).toHaveBeenCalledWith('bob');
  expect(useOnboarding.getState().welcomed).toBe(true);
});

it('brings Welcome back after the last account signs out (AUTH-01)', async () => {
  fakeEngine.method('session.signOut').mockResolvedValue(undefined);
  fakeEngine.method('session.accounts').mockResolvedValue([]);

  await signOutAccount('alice');

  expect(useOnboarding.getState().welcomed).toBe(false);
  expect(useSessionStore.getState().accounts).toEqual([]);
});
