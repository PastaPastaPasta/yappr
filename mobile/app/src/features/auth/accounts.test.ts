import type { AccountDTO, SessionDTO } from '@engine/api';
import { router } from 'expo-router';

import { useSessionStore } from '~/data/session';
import { engineModule, fakeEngine } from '~/data/testing/fake-engine';
import { useToastStore } from '~/ui/toast';

import {
  accountName,
  addAccount,
  finishWalletSwitch,
  returnFromAddAccount,
  signOutAccount,
  switchAccount,
  useAccounts,
} from './accounts';
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
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/**
 * Restarts the engine; `boot.now()` brings the new epoch up restoring `next`, as the session sync
 * would apply it (at once with `auto`).
 */
const restartsAs = (next: SessionDTO | null, { auto = false } = {}) => {
  const boot = {
    now: () => {
      fakeEngine.setStatus({ state: 'ready' });
      useSessionStore.setState({ status: next ? 'signed-in' : 'signed-out', session: next });
    },
  };
  fakeEngine.method('session.current').mockResolvedValue(next);
  restart.mockImplementation(() => {
    fakeEngine.setStatus({ state: 'starting', epoch: engineModule.engineSupervisor.getStatus().epoch + 1 });
    if (auto) setTimeout(boot.now, 0);
  });
  return boot;
};
const bootsAs = (next: SessionDTO | null) => restartsAs(next, { auto: true });

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

it('finishes a switch the engine prepared for a wallet sign-in as a parked account', async () => {
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [account('bob')] });
  bootsAs(session('bob', 'bob'));

  const switching = finishWalletSwitch('bob');
  expect(useAccounts.getState().transition).toEqual({ kind: 'switch', label: 'Switching to @bob…' });
  await expect(switching).resolves.toEqual(session('bob', 'bob'));
  // The engine already parked and prepared the switch: only the restart is left.
  expect(fakeEngine.method('session.switchAccount')).not.toHaveBeenCalled();
  expect(restart).toHaveBeenCalledTimes(1);
  expect(useToastStore.getState().current?.message).toBe('Switched to @bob');
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
  await flush();
  expect(fakeEngine.method('session.switchAccount')).toHaveBeenCalledWith('alice');
  expect(useAccounts.getState().returnTo).toBeNull();
});

it('signs out the active account and moves to the next one (AUTH-11)', async () => {
  fakeEngine.method('session.signOut').mockResolvedValue(undefined);
  fakeEngine.method('session.accounts').mockResolvedValue([account('bob')]);
  fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
  bootsAs(session('bob'));

  await expect(signOutAccount('alice')).resolves.toBe(true);
  await flush();

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

it('keeps the switch progress up after signing out the active account, until the next one is back', async () => {
  fakeEngine.method('session.signOut').mockResolvedValue(undefined);
  fakeEngine.method('session.accounts').mockResolvedValue([account('bob')]);
  fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
  const boot = restartsAs(session('bob'));

  await signOutAccount('alice');
  await flush();
  expect(restart).toHaveBeenCalledTimes(1);
  expect(useAccounts.getState().transition?.kind).toBe('switch');

  boot.now();
  await flush();
  expect(useAccounts.getState().transition).toBeNull();
  expect(useToastStore.getState().current?.message).toBe('Switched to @bob');
});

it('waits for the new engine when switching from signed out, ignoring writes for the old one', async () => {
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [account('bob')] });
  fakeEngine.method('session.switchAccount').mockResolvedValue(undefined);
  const boot = restartsAs(session('bob'));

  let result: boolean | undefined;
  switchAccount({ identityId: 'bob', username: 'bob' })
    .then((switched) => {
      result = switched;
    })
    .catch(() => undefined);
  await flush();
  // A late account-list read for the old engine lands while the new one boots.
  useSessionStore.setState({ accounts: [account('bob')] });
  await flush();
  expect(result).toBeUndefined();
  expect(useAccounts.getState().transition?.kind).toBe('switch');

  boot.now();
  await flush();
  expect(result).toBe(true);
  expect(useAccounts.getState().transition).toBeNull();
});
