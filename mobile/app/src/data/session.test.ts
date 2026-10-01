import type { CapabilitiesDTO, SessionDTO } from '@engine/api';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';

import { useEngineEvent } from './events';
import { queryKeys } from './keys';
import { requireAuth, useSignInPrompt } from './require-auth';
import { startSessionSync, useCapabilities, useSession, useSessionStore } from './session';
import { fakeEngine } from './testing/fake-engine';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

const session = (identityId: string): SessionDTO => ({
  identityId,
  network: 'devnet',
  username: `${identityId}-name`,
  credits: 5n,
  hasEncryptionKey: true,
  method: 'key',
});

const flush = () => act(async () => {});

let stop: () => void = () => undefined;

afterAll(() => queryClient.clear());

beforeEach(() => {
  fakeEngine.reset();
  queryClient.clear();
  syncStorage.removeItem('yappr.session.identity');
  useSessionStore.setState({ status: 'unknown', session: null, accounts: [] });
  useSignInPrompt.setState({ open: false });
  fakeEngine.method('session.accounts').mockResolvedValue([]);
});
afterEach(() => stop());

describe('session sync', () => {
  it('asks the engine once it takes calls, then follows session.changed', async () => {
    fakeEngine.method('session.current').mockResolvedValue(session('alice'));
    stop = startSessionSync();
    expect(fakeEngine.method('session.current')).not.toHaveBeenCalled();

    fakeEngine.setStatus({ state: 'ready', epoch: 1 });
    await flush();
    const { result } = renderHook(() => useSession());
    expect(result.current).toMatchObject({ status: 'signed-in', identityId: 'alice', signedIn: true });
    expect(fakeEngine.method('session.accounts')).toHaveBeenCalled();

    act(() => fakeEngine.emit('session.changed', { session: null, reason: 'signed-out' }));
    expect(result.current).toMatchObject({ status: 'signed-out', identityId: null, signedIn: false });
  });

  it("asks again after an engine restart, but keeps the cache for the same account", async () => {
    syncStorage.setItem('yappr.session.identity', 'alice');
    fakeEngine.method('session.current').mockResolvedValue(session('alice'));
    queryClient.setQueryData(queryKeys.post.detail('p'), { id: 'p' });
    stop = startSessionSync();
    fakeEngine.setStatus({ state: 'ready', epoch: 1 });
    await flush();
    fakeEngine.setStatus({ state: 'ready', epoch: 2 });
    await flush();

    expect(fakeEngine.method('session.current')).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(queryKeys.post.detail('p'))).toEqual({ id: 'p' });
  });

  it("drops another account's cache: a switch, a sign-out, or a different account at launch", async () => {
    syncStorage.setItem('yappr.session.identity', 'bob');
    fakeEngine.method('session.current').mockResolvedValue(session('alice'));
    queryClient.setQueryData(queryKeys.post.detail('p'), { id: 'p' });
    stop = startSessionSync();
    fakeEngine.setStatus({ state: 'ready', epoch: 1 });
    await flush();
    expect(queryClient.getQueryData(queryKeys.post.detail('p'))).toBeUndefined();
    expect(syncStorage.getItem('yappr.session.identity')).toBe('alice');

    queryClient.setQueryData(queryKeys.post.detail('p'), { id: 'p' });
    act(() => fakeEngine.emit('session.changed', { session: null, reason: 'signed-out' }));
    await flush();
    expect(queryClient.getQueryData(queryKeys.post.detail('p'))).toBeUndefined();
  });

  it('refetches with viewer marks after a sign-in', async () => {
    fakeEngine.method('session.current').mockResolvedValue(null);
    queryClient.setQueryData(queryKeys.post.detail('p'), { id: 'p' });
    stop = startSessionSync();
    fakeEngine.setStatus({ state: 'ready', epoch: 1 });
    await flush();

    act(() => fakeEngine.emit('session.changed', { session: session('alice'), reason: 'signed-in' }));
    await flush();
    expect(queryClient.getQueryState(queryKeys.post.detail('p'))?.isInvalidated).toBe(true);
  });
});

describe('useCapabilities', () => {
  it("reads the engine's, and remembers them for the next launch", () => {
    stop = startSessionSync();
    const { result } = renderHook(() => useCapabilities());
    const capabilities = { repostsAreQuotes: true } as CapabilitiesDTO;

    act(() => fakeEngine.setStatus({ info: { capabilities } }));
    expect(result.current).toBe(capabilities);
    expect(JSON.parse(syncStorage.getItem('yappr.capabilities')!)).toMatchObject({ capabilities });
  });
});

describe('requireAuth', () => {
  it('runs the action signed in, and asks to sign in otherwise (without running it later)', () => {
    const action = jest.fn();
    useSessionStore.setState({ status: 'signed-in', session: session('alice') });
    requireAuth(action);
    expect(action).toHaveBeenCalledTimes(1);

    useSessionStore.setState({ status: 'signed-out', session: null });
    requireAuth(action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(useSignInPrompt.getState().open).toBe(true);
  });

  it('waits for the engine to restore the session', () => {
    const action = jest.fn();
    requireAuth(action);
    expect(action).not.toHaveBeenCalled();
    expect(useSignInPrompt.getState().open).toBe(false);

    act(() => useSessionStore.setState({ status: 'signed-in', session: session('alice') }));
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('useEngineEvent', () => {
  it('delivers typed payloads to the latest handler until unmount', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender, unmount } = renderHook(({ handler }) => useEngineEvent('notifications.count', handler), {
      initialProps: { handler: first },
    });
    rerender({ handler: second });
    act(() => fakeEngine.emit('notifications.count', { unread: 3 }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ unread: 3 });

    unmount();
    await waitFor(() => expect(fakeEngine.listenerCount('notifications.count')).toBe(0));
  });
});
