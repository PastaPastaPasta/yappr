import type { SessionDTO } from '@engine/api';
import { act, renderHook } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

import { useSessionStore } from '~/data/session';
import { useAppLockSettings, useLockState } from '~/features/auth/app-lock';
import { useToastStore } from '~/ui/toast';

import { OPEN_IN_BROWSER, routeInboundLink, UNSUPPORTED_LINK, useInboundLinkEffects } from './inbound-links';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));

const ID = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
const viewer: SessionDTO = {
  identityId: ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};
const push = router.push as jest.Mock;
const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useAppLockSettings.setState({ enabled: false });
  useLockState.setState({ locked: false, covered: false, authenticating: false, backgroundAt: null });
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
  useToastStore.setState({ current: null });
});

it('opens a known link at once while the app is unlocked', () => {
  expect(routeInboundLink(`yappr-dev://post?id=${ID}`, false)).toBe(`/post/${ID}`);
});

describe('app lock (SR-01)', () => {
  it('holds a link that arrives while locked, and opens it once unlocked', () => {
    useAppLockSettings.setState({ enabled: true });
    useLockState.setState({ locked: true });
    const { rerender } = renderHook(({ ready }: { ready: boolean }) => useInboundLinkEffects(ready), { initialProps: { ready: true } });

    // A warm link stays put; nothing is presented over the lock screen.
    let route: string | null = '';
    act(() => {
      route = routeInboundLink('yappr-dev://login', false);
    });
    expect(route).toBeNull();
    expect(push).not.toHaveBeenCalled();

    act(() => useLockState.setState({ locked: false }));
    rerender({ ready: true });
    expect(push).toHaveBeenCalledWith('/sign-in');
  });

  it('lands the launch link home while locked, then opens it after the unlock', () => {
    useLockState.setState({ locked: true });
    expect(routeInboundLink(`yappr-dev://messages?startConversation=${ID}`, true)).toBe('/');
    renderHook(() => useInboundLinkEffects(true));
    expect(push).not.toHaveBeenCalled();

    act(() => useLockState.setState({ locked: false }));
    expect(push).toHaveBeenCalledWith(`/messages/new?with=${ID}`);
  });

  it('also holds links while the lock screen only covers the app (inactive)', () => {
    useLockState.setState({ covered: true });
    expect(routeInboundLink('yappr-dev://login', false)).toBeNull();
    renderHook(() => useInboundLinkEffects(true));
    expect(push).not.toHaveBeenCalled();
    act(() => useLockState.setState({ covered: false }));
    expect(push).toHaveBeenCalledWith('/sign-in');
  });
});

describe('unsupported and web-only links (SR-13, NET-11)', () => {
  it('goes home with "This link isn\'t supported in the app" and Open in browser', () => {
    renderHook(() => useInboundLinkEffects(true));
    let route: string | null = null;
    act(() => {
      // A malformed known link (dev builds pass unknown app paths through for screenshots).
      route = routeInboundLink('yappr-dev://post?id=bad', false);
    });
    expect(route).toBe('/');
    const current = useToastStore.getState().current;
    expect(current?.message).toBe(UNSUPPORTED_LINK);
    expect(current?.action?.label).toBe(OPEN_IN_BROWSER);

    current?.action?.onPress();
    expect(openBrowser).toHaveBeenCalledWith('https://yap.pr/devnet/post?id=bad');
  });

  it('opens a web-only page in the in-app browser, once the navigator is up', () => {
    expect(routeInboundLink('yappr-dev://dpns/register', true)).toBe('/');
    const { rerender } = renderHook(({ ready }: { ready: boolean }) => useInboundLinkEffects(ready), { initialProps: { ready: false } });
    expect(openBrowser).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(openBrowser).toHaveBeenCalledWith('https://yap.pr/devnet/dpns/register');
  });

  it('ignores /login while signed in, as before the engine restores (the last account)', () => {
    useSessionStore.setState({ status: 'signed-in', session: viewer });
    expect(routeInboundLink('yappr-dev://login', false)).toBeNull();
    expect(routeInboundLink('yappr-dev://login', true)).toBe('/');
    expect(routeInboundLink(`yappr-dev://user?id=${ID}`, false)).toBe('/profile');
  });
});
