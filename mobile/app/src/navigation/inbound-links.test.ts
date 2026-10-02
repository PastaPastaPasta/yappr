import type { SessionDTO } from '@engine/api';
import { act, renderHook } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';

import { useSessionStore } from '~/data/session';
import { useToastStore } from '~/ui/toast';

import { OPEN_IN_BROWSER, routeInboundLink, UNSUPPORTED_LINK, useInboundLinkEffects } from './inbound-links';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
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
const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
  useToastStore.setState({ current: null });
});

it('opens a known link at once while the app is unlocked', () => {
  expect(routeInboundLink(`yappr-dev://post?id=${ID}`, false)).toBe(`/post/${ID}`);
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
