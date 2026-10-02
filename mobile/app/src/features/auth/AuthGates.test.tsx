import type { SessionDTO } from '@engine/api';
import { act, render } from '@testing-library/react-native';
import { router } from 'expo-router';

import { useSessionStore } from '~/data/session';
import { fakeEngine } from '~/data/testing/fake-engine';

import { useAccounts } from './accounts';
import { useAppLockSettings, useLockState } from './app-lock';
import { AuthGates } from './AuthGates';
import { useKeyExchange } from './key-exchange';
import { useOnboarding } from './onboarding';
import { acceptTerms, useTermsStore } from './terms';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('./AccountSwitcher', () => ({ AccountSwitcherSheet: () => null }));
jest.mock('./AppLockOverlay', () => ({ AppLockOverlay: () => null }));
const mockPath = { current: '/' };
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  usePathname: () => mockPath.current,
  useRootNavigationState: () => ({ key: 'root' }),
}));

const alice: SessionDTO = {
  identityId: 'alice',
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: false,
  method: 'key',
};
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

/** Renders the gates at `path`; `go(next)` moves the app to another route. */
function mount(path: string) {
  mockPath.current = path;
  const view = render(<AuthGates />);
  return (next: string) => {
    mockPath.current = next;
    view.rerender(<AuthGates />);
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  useOnboarding.setState({ welcomed: true });
  useTermsStore.setState({ accepted: {} });
  useAccounts.setState({ transition: null, returnTo: null });
  useSessionStore.setState({ status: 'signed-in', session: alice, accounts: [] });
  useAppLockSettings.setState({ enabled: false });
  useLockState.setState({ locked: false, covered: false, authenticating: false, backgroundAt: null });
  fakeEngine.method('session.cancelKeyExchange').mockResolvedValue(undefined);
});

describe('terms gate (AUTH-09)', () => {
  it('opens for a signed-in account that has not accepted, once the sign-in flow has closed', () => {
    const go = mount('/sign-in/key');
    expect(router.push).not.toHaveBeenCalled();
    go('/');
    expect(router.push).toHaveBeenCalledWith('/terms-gate');
  });

  it('waits for an account switch to finish, and stays shut once accepted', () => {
    useAccounts.setState({ transition: { kind: 'switch', label: 'Switching…' } });
    mount('/');
    expect(router.push).not.toHaveBeenCalled();

    act(() => acceptTerms('devnet-test', 'alice'));
    act(() => useAccounts.setState({ transition: null }));
    expect(router.push).not.toHaveBeenCalled();
  });
  it('never opens over the app lock, where iOS would draw it above the lock screen (SR-01)', () => {
    useAppLockSettings.setState({ enabled: true });
    useLockState.setState({ locked: true });
    mount('/');
    expect(router.push).not.toHaveBeenCalled();

    // The lock screen covering an inactive app holds it too.
    act(() => useLockState.setState({ locked: false, covered: true }));
    expect(router.push).not.toHaveBeenCalled();

    act(() => useLockState.setState({ covered: false }));
    expect(router.push).toHaveBeenCalledWith('/terms-gate');
  });
});

describe('leaving the sign-in flow', () => {
  it('forgets a failed wallet sign-in, so the next visit starts fresh', () => {
    useSessionStore.setState({ status: 'signed-out', session: null });
    useKeyExchange.setState({
      phase: { name: 'error', title: 'Sign-in failed', message: 'x', retry: 'start' },
      request: { requestId: 'r1', uri: 'dash-key:r1', expiresAt: new Date(Date.now() + 60_000) },
    });
    const go = mount('/sign-in/wallet');
    go('/');

    expect(useKeyExchange.getState().phase.name).toBe('idle');
    expect(fakeEngine.method('session.cancelKeyExchange')).toHaveBeenCalledWith('r1');
  });

  it('goes back to the parked account after an abandoned "Add account"', () => {
    useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
    useAccounts.setState({ returnTo: 'alice' });
    fakeEngine.method('session.switchAccount').mockReturnValue(new Promise(() => undefined));
    const go = mount('/sign-in');
    go('/');

    expect(useAccounts.getState().returnTo).toBeNull();
    expect(useAccounts.getState().transition?.kind).toBe('switch');
  });
});

describe('launch', () => {
  it('shows Welcome on a first launch (AUTH-01)', () => {
    useOnboarding.setState({ welcomed: false });
    useSessionStore.setState({ status: 'unknown', session: null });
    mount('/');
    expect(router.push).toHaveBeenCalledWith('/welcome');
  });

  it('reopens a wallet request the engine still holds on the screen it was made on', async () => {
    useSessionStore.setState({ status: 'signed-out', session: null });
    fakeEngine.setStatus({ state: 'ready' });
    fakeEngine
      .method('session.pendingKeyExchange')
      .mockResolvedValue({ requestId: 'r1', uri: 'dash-key:r1', expiresAt: new Date(Date.now() + 60_000) });
    // A QR request was started before the app was killed; the new launch starts idle.
    useKeyExchange.setState({ mode: 'wallet', phase: { name: 'idle' } });
    useKeyExchange.setState({ mode: 'qr', phase: { name: 'starting' } });
    useKeyExchange.setState({ mode: 'wallet', phase: { name: 'idle' }, request: null });

    mount('/');
    await flush();
    expect(router.push).toHaveBeenCalledWith('/sign-in/qr?resume=1');
  });

  it('leaves a request alone when the sign-in flow already owns it (a slow boot)', async () => {
    useSessionStore.setState({ status: 'signed-out', session: null });
    fakeEngine.setStatus({ state: 'ready' });
    fakeEngine
      .method('session.pendingKeyExchange')
      .mockResolvedValue({ requestId: 'r1', uri: 'dash-key:r1', expiresAt: new Date(Date.now() + 60_000) });
    useKeyExchange.setState({ mode: 'wallet', phase: { name: 'starting' }, request: null });

    mount('/sign-in/wallet');
    await flush();
    expect(router.push).not.toHaveBeenCalled();
    expect(fakeEngine.method('session.pendingKeyExchange')).not.toHaveBeenCalled();
  });

  it('drops a resume whose answer arrives after the user started signing in', async () => {
    useSessionStore.setState({ status: 'signed-out', session: null });
    fakeEngine.setStatus({ state: 'ready' });
    let answer: (value: unknown) => void = () => undefined;
    fakeEngine.method('session.pendingKeyExchange').mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    useKeyExchange.setState({ mode: 'wallet', phase: { name: 'idle' }, request: null });

    const go = mount('/');
    go('/sign-in/qr');
    const request = { requestId: 'r2', uri: 'dash-key:r2', expiresAt: new Date(Date.now() + 60_000) };
    useKeyExchange.setState({ mode: 'qr', phase: { name: 'waiting', request }, request });
    answer(request);
    await flush();
    expect(router.push).not.toHaveBeenCalled();
    useKeyExchange.setState({ mode: 'wallet', phase: { name: 'idle' }, request: null });
  });

  it('holds a resume whose answer arrives after the lock came up, and reopens it after unlock (SR-01)', async () => {
    useSessionStore.setState({ status: 'signed-out', session: null });
    useAppLockSettings.setState({ enabled: true });
    fakeEngine.setStatus({ state: 'ready' });
    const request = { requestId: 'r3', uri: 'dash-key:r3', expiresAt: new Date(Date.now() + 60_000) };
    let answer: (value: unknown) => void = () => undefined;
    fakeEngine.method('session.pendingKeyExchange').mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    useKeyExchange.setState({ mode: 'wallet', phase: { name: 'idle' }, request: null });

    mount('/');
    // The user leaves the app while the engine answers: the cover is up when the answer lands.
    act(() => useLockState.setState({ covered: true }));
    answer(request);
    await flush();
    expect(router.push).not.toHaveBeenCalled();

    fakeEngine.method('session.pendingKeyExchange').mockResolvedValue(request);
    act(() => useLockState.setState({ covered: false }));
    await flush();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/sign-in\/(wallet|qr)\?resume=1$/));
  });
});
