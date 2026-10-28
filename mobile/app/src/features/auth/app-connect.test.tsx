import type { AppConnectFlowDTO, AppConnectPhaseDTO, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { router } from 'expo-router';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ConnectScreen from '~/app/sign-in/connect';
import { useSessionStore } from '~/data/session';
import { fakeEngine } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { useToastStore } from '~/ui/toast';

import { afterSignOut, loadSignedInAgain, reauthenticate, useAccounts } from './accounts';
import { parseAppConnectReturn, takeAppConnectReturnLink, useAppConnect } from './app-connect';
import { useRevokedNotice } from './app-connect-status';
import { AppConnectNotices } from './AppConnectNotices';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('./accounts', () => ({
  ...jest.requireActual<typeof import('./accounts')>('./accounts'),
  loadSignedInAgain: jest.fn(async (session: unknown) => session),
  afterSignOut: jest.fn(async () => undefined),
  reauthenticate: jest.fn(async () => undefined),
}));
let mockPathname = '/';
const mockGoBack = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  Stack: { Screen: () => null },
  useNavigation: () => ({
    getParent: () => ({ canGoBack: () => true, goBack: mockGoBack }),
    getState: () => ({ routes: [{ key: 'connect' }] }),
    addListener: () => () => undefined,
  }),
  useRoute: () => ({ key: 'connect' }),
  useLocalSearchParams: () => mockParams,
  usePathname: () => mockPathname,
  useIsFocused: () => true,
}));

const HASH = 'ab'.repeat(20);
const URI = `dash-key:abc?n=d&v=2&cb=https%3A%2F%2Fyap.pr%2Fdevnet%2Fconnect%2F%3Fr%3D${HASH}%26app%3Dyappr-dev`;
const alice: SessionDTO = {
  identityId: 'AliceIdentity1111111111111111111111111111111',
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'app-connect',
};
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const render = (element: ReactElement) =>
  rtlRender(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
    </SafeAreaProvider>,
  );
beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

/** The engine numbers its flows for the app's lifetime: each test's flows come after the last test's. */
let testFlow = 0;
const flow = (phase: AppConnectPhaseDTO & { flow?: number; renew?: boolean }): AppConnectFlowDTO => ({ flow: testFlow, renew: false, ...phase });
async function open(params: Record<string, string>, first: AppConnectFlowDTO = flow({ phase: 'waiting', uri: URI, requestHash: HASH })) {
  mockParams = params;
  fakeEngine.method('session.appConnectStart').mockResolvedValue(first);
  render(<ConnectScreen />);
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  fakeEngine.reset();
  fakeEngine.setStatus({ state: 'ready', epoch: 1 });
  for (const path of ['session.appConnectCancel', 'session.appConnectPollNow', 'session.appConnectReject', 'session.appConnectCheckAgain']) {
    fakeEngine.method(path).mockResolvedValue(undefined);
  }
  fakeEngine.method('profiles.get').mockResolvedValue({ id: alice.identityId, username: 'alice', displayName: 'Alice', avatar: null });
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  useAppConnect.setState(useAppConnect.getInitialState());
  useSessionStore.setState({ status: 'signed-in', session: alice, accounts: [] });
  useRevokedNotice.setState({ account: null });
  mockPathname = '/';
  testFlow += 10;
});
afterEach(() => jest.useRealTimers());

describe('the wallet sign-in on App Connect builds', () => {
  it('asks the engine for a request that returns to this app, and opens the wallet with it', async () => {
    await open({ mode: 'wallet' });
    expect(fakeEngine.method('session.appConnectStart')).toHaveBeenCalledWith({
      renew: false,
      fresh: false,
      returnTo: { webBasePath: '/devnet', scheme: 'yappr-dev' },
    });
    expect(Linking.openURL).toHaveBeenCalledWith(URI);
    expect(screen.getByTestId('kx-waiting')).toBeTruthy();
    // No countdown, anywhere.
    expect(screen.queryByText(/\d+:\d\d/)).toBeNull();
  });

  describe('on a staging build that offers both carriers', () => {
    const DASHPAY_URI = `dashpay://connect?v=2&n=d&r=abc&cb=https%3A%2F%2Fyap.pr%2Fdevnet%2Fconnect%2F%3Fr%3D${HASH}%26app%3Dyappr-dev`;
    // The app opens a request's wallet link once, so each test brings its own request.
    const both = (requestHash: string) =>
      flow({
        phase: 'waiting',
        uri: URI,
        uris: [
          { carrier: 'dash-key', uri: URI },
          { carrier: 'dashpay', uri: DASHPAY_URI },
        ],
        requestHash,
      });
    const installed = (schemes: Record<string, boolean>) =>
      jest.spyOn(Linking, 'canOpenURL').mockImplementation(async (url) => schemes[url.split(':')[0]] === true);
    afterEach(() => jest.mocked(Linking.canOpenURL).mockRestore());

    it('opens dashpay://connect when only a wallet for that scheme is installed', async () => {
      installed({ dashpay: true });
      await open({ mode: 'wallet' }, both('c1'.repeat(20)));
      await act(async () => {});
      expect(Linking.openURL).toHaveBeenCalledTimes(1);
      expect(Linking.openURL).toHaveBeenCalledWith(DASHPAY_URI);
    });

    it('falls back to dash-key: when no wallet answers for dashpay', async () => {
      installed({ 'dash-key': true });
      await open({ mode: 'wallet' }, both('c2'.repeat(20)));
      await act(async () => {});
      expect(Linking.openURL).toHaveBeenCalledWith(URI);
      jest.mocked(Linking.openURL).mockClear();
      installed({});
      await act(async () => fireEvent.press(screen.getByTestId('kx-open-again')));
      await act(async () => {});
      expect(Linking.openURL).toHaveBeenCalledWith(URI);
    });

    it('opens nothing when the user switches to the QR code while the schemes are being asked about', async () => {
      let answer: (value: boolean) => void = () => undefined;
      jest.spyOn(Linking, 'canOpenURL').mockImplementation(
        (url) => (url.startsWith('dashpay') ? new Promise<boolean>((resolve) => { answer = resolve; }) : Promise.resolve(false)),
      );
      await open({ mode: 'wallet' }, both('c4'.repeat(20)));
      await act(async () => fireEvent.press(screen.getByTestId('kx-other-device')));
      await act(async () => answer(true));
      expect(Linking.openURL).not.toHaveBeenCalled();
    });

    it('shows the default (dash-key:) link as the QR code', async () => {
      installed({ dashpay: true });
      await open({ mode: 'qr' }, both('c3'.repeat(20)));
      expect(screen.getByTestId('kx-qr')).toBeTruthy();
      expect(Linking.openURL).not.toHaveBeenCalled();
    });
  });

  it('shows the request as a QR code for a wallet on another device, without opening anything', async () => {
    await open({ mode: 'qr' });
    expect(screen.getByTestId('kx-qr')).toBeTruthy();
    expect(screen.getByTestId('kx-copy-link')).toBeTruthy();
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it('a resumed request (the app was killed in the wallet) does not open the wallet again', async () => {
    await open({ mode: 'wallet', resume: '1' });
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it('asks "Is this you?" for a verified answer, then signs in with it and closes', async () => {
    await open({ mode: 'qr' });
    act(() => fakeEngine.emit('session.appConnect', flow({ phase: 'confirm', uri: URI, requestHash: HASH, candidates: [{ identityId: alice.identityId, username: 'alice.dash' }] })));
    await act(async () => {});
    expect(screen.getByText('Is this you?')).toBeTruthy();
    expect(screen.getByText('Continue as @alice')).toBeTruthy();

    fakeEngine.method('session.appConnectAccept').mockResolvedValue({ status: 'signed-in', session: alice, reload: false });
    await act(async () => fireEvent.press(screen.getByTestId('ac-continue')));
    expect(fakeEngine.method('session.appConnectAccept')).toHaveBeenCalledWith({ identityId: alice.identityId });
    expect(screen.getByTestId('kx-signed-in')).toBeTruthy();
    expect(loadSignedInAgain).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(mockGoBack).toHaveBeenCalled();
    expect(fakeEngine.method('session.appConnectCancel')).not.toHaveBeenCalled();
  });

  it('loads an account that was parked on this device again after it signs in', async () => {
    await open({ mode: 'qr' }, flow({ phase: 'confirm', uri: URI, requestHash: HASH, candidates: [{ identityId: alice.identityId, username: null }] }));
    fakeEngine.method('session.appConnectAccept').mockResolvedValue({ status: 'signed-in', session: alice, reload: true });
    await act(async () => fireEvent.press(screen.getByTestId('ac-continue')));
    expect(loadSignedInAgain).toHaveBeenCalledWith(alice);
  });

  it('offers a chooser when several accounts answered, and "None of these are me" starts over', async () => {
    const bob = 'BobIdentity22222222222222222222222222222222';
    await open({ mode: 'qr' }, flow({
      phase: 'confirm',
      uri: URI,
      requestHash: HASH,
      candidates: [{ identityId: alice.identityId, username: 'alice' }, { identityId: bob, username: null }],
    }));
    expect(screen.getByTestId('ac-chooser')).toBeTruthy();
    expect(screen.getByTestId('ac-continue-1')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('ac-not-me')));
    expect(fakeEngine.method('session.appConnectReject')).toHaveBeenCalled();
    act(() => fakeEngine.emit('session.appConnect', flow({ phase: 'waiting', uri: URI, requestHash: HASH })));
    expect(screen.getByText(/Someone else may have scanned your code/)).toBeTruthy();
  });

  it('takes the rejected accounts away at once, while the new request is still being made', async () => {
    await open({ mode: 'qr' }, flow({ phase: 'confirm', uri: URI, requestHash: HASH, candidates: [{ identityId: alice.identityId, username: 'alice' }] }));
    fakeEngine.method('session.appConnectReject').mockReturnValue(new Promise(() => undefined));
    await act(async () => fireEvent.press(screen.getByTestId('ac-not-me')));
    expect(screen.queryByTestId('ac-continue')).toBeNull();
    await act(async () => {
      const { acceptAccount } = jest.requireActual<typeof import('./app-connect')>('./app-connect');
      await acceptAccount(alice.identityId);
    });
    expect(fakeEngine.method('session.appConnectAccept')).not.toHaveBeenCalled();
  });

  it('signs in once however often "Continue" is tapped', async () => {
    await open({ mode: 'qr' }, flow({ phase: 'confirm', uri: URI, requestHash: HASH, candidates: [{ identityId: alice.identityId, username: 'alice' }] }));
    let answer: (value: unknown) => void = () => undefined;
    fakeEngine.method('session.appConnectAccept').mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    fireEvent.press(screen.getByTestId('ac-continue'));
    // The card is gone; a second confirmation (the same tick, another account) changes nothing.
    await act(async () => {
      const { acceptAccount } = jest.requireActual<typeof import('./app-connect')>('./app-connect');
      await Promise.race([acceptAccount(alice.identityId), Promise.resolve()]);
    });
    expect(fakeEngine.method('session.appConnectAccept')).toHaveBeenCalledTimes(1);
    await act(async () => answer({ status: 'signed-in', session: alice, reload: false }));
    expect(screen.getByTestId('kx-signed-in')).toBeTruthy();
  });

  it('drops a late answer of an earlier request once a new one starts', async () => {
    await open({ mode: 'qr' }, flow({ phase: 'waiting', uri: URI, requestHash: HASH, flow: testFlow + 4 }));
    fakeEngine.method('session.appConnectStart').mockReturnValue(new Promise(() => undefined));
    const { startAppConnect } = jest.requireActual<typeof import('./app-connect')>('./app-connect');
    act(() => {
      startAppConnect('qr', { fresh: true }).catch(() => undefined);
    });
    act(() => fakeEngine.emit('session.appConnect', flow({ phase: 'confirm', uri: URI, requestHash: HASH, flow: testFlow + 4, candidates: [{ identityId: alice.identityId, username: 'alice' }] })));
    expect(useAppConnect.getState().step.name).toBe('starting');
    act(() => fakeEngine.emit('session.appConnect', flow({ phase: 'waiting', uri: URI, requestHash: HASH, flow: testFlow + 6 })));
    expect(useAppConnect.getState().flow).toMatchObject({ flow: testFlow + 6, phase: 'waiting' });
  });

  it('picks the request up on a new engine when the engine restarted while it was being made', async () => {
    mockParams = { mode: 'wallet' };
    fakeEngine.method('session.appConnectStart').mockRejectedValueOnce(Object.assign(new Error('The engine restarted'), { code: 'ENGINE_RESTARTED' }));
    render(<ConnectScreen />);
    await act(async () => {});
    expect(useAppConnect.getState().step.name).toBe('starting');
    // (Another request than earlier tests', which the wallet has seen.)
    fakeEngine.method('session.appConnectStart').mockResolvedValue(flow({ phase: 'waiting', uri: URI, requestHash: 'cd'.repeat(20), flow: 1 }));
    await act(async () => fakeEngine.setStatus({ state: 'ready', epoch: 3 + testFlow }));
    expect(fakeEngine.method('session.appConnectStart')).toHaveBeenCalledTimes(2);
    expect(useAppConnect.getState().flow).toMatchObject({ phase: 'waiting', flow: 1 });
    // That start never got as far as the wallet: this one opens it.
    expect(Linking.openURL).toHaveBeenCalledWith(URI);
  });

  it('follows a restarted engine, whose flows are numbered from the start again', async () => {
    await open({ mode: 'qr' }, flow({ phase: 'waiting', uri: URI, requestHash: HASH, flow: testFlow + 5 }));
    fakeEngine.method('session.appConnectStart').mockResolvedValue(flow({ phase: 'waiting', uri: URI, requestHash: HASH, flow: 1 }));
    await act(async () => fakeEngine.setStatus({ state: 'ready', epoch: 2 + testFlow }));
    expect(fakeEngine.method('session.appConnectStart')).toHaveBeenLastCalledWith(expect.objectContaining({ fresh: false }));
    act(() => fakeEngine.emit('session.appConnect', flow({ phase: 'confirm', uri: URI, requestHash: HASH, flow: 1, candidates: [{ identityId: alice.identityId, username: 'alice' }] })));
    expect(useAppConnect.getState().flow).toMatchObject({ phase: 'confirm', flow: 1 });
  });

  it('signs an account in again only as that account', async () => {
    useAccounts.setState({ reauth: alice.identityId });
    try {
      await open({ mode: 'qr' });
      expect(fakeEngine.method('session.appConnectStart')).toHaveBeenCalledWith(expect.objectContaining({ renew: false, reauth: alice.identityId }));
    } finally {
      useAccounts.setState({ reauth: null });
    }
  });

  it('never renews for an account that is not the one signed in', async () => {
    const stranger = 'StrangerIdentity33333333333333333333333333';
    fakeEngine.method('session.appConnectAccept').mockResolvedValue({ status: 'renewed', session: alice });
    await open({ mode: 'qr', renew: '1' }, flow({ renew: true, phase: 'confirm', uri: URI, requestHash: HASH, candidates: [{ identityId: stranger, username: null }] }));
    expect(fakeEngine.method('session.appConnectAccept')).not.toHaveBeenCalled();
  });

  it('renews without asking: the one answer is the signed-in account', async () => {
    fakeEngine.method('session.appConnectAccept').mockResolvedValue({ status: 'renewed', session: alice });
    await open({ mode: 'wallet', renew: '1' }, flow({ renew: true, phase: 'confirm', uri: URI, requestHash: HASH, candidates: [{ identityId: alice.identityId, username: 'alice' }] }));
    await act(async () => {});
    expect(fakeEngine.method('session.appConnectStart')).toHaveBeenCalledWith(expect.objectContaining({ renew: true }));
    expect(fakeEngine.method('session.appConnectAccept')).toHaveBeenCalledWith({ identityId: alice.identityId });
    expect(screen.getByText('Renewed')).toBeTruthy();
  });

  it('turns an unanswered request into "Check again", and cancelling forgets it', async () => {
    await open({ mode: 'qr' }, flow({ phase: 'timeout', uri: URI, requestHash: HASH }));
    await act(async () => fireEvent.press(screen.getByTestId('kx-check-again')));
    expect(fakeEngine.method('session.appConnectCheckAgain')).toHaveBeenCalled();
    fireEvent.press(screen.getByText('Cancel'));
    expect(fakeEngine.method('session.appConnectCancel')).toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalled();
  });

  it('says why wallet sign-in is not available, and retries only what a retry can fix', async () => {
    await open({ mode: 'wallet' }, flow({ phase: 'unavailable', reason: 'untrusted' }));
    expect(screen.getByText('Wallet sign-in is paused')).toBeTruthy();
    expect(screen.queryByTestId('kx-try-again')).toBeNull();
  });
});

describe("the wallet's return link", () => {
  it('reads the app-scheme and yap.pr forms, and nothing else', () => {
    expect(parseAppConnectReturn(`yappr-dev://connect?r=${HASH}&ac=ok`)).toEqual({ requestHash: HASH, status: 'ok' });
    expect(parseAppConnectReturn(`yappr-dev:///connect?r=${HASH.toUpperCase()}`)).toEqual({ requestHash: HASH, status: null });
    expect(parseAppConnectReturn(`https://yap.pr/devnet/connect/?r=${HASH}&app=yappr-dev&ac=declined`)).toEqual({ requestHash: HASH, status: 'declined' });
    // The path forms a router may hand over in place of the full URL.
    expect(parseAppConnectReturn(`/connect?r=${HASH}&ac=ok`)).toEqual({ requestHash: HASH, status: 'ok' });
    expect(parseAppConnectReturn(`/devnet/connect/?r=${HASH}&app=yappr-dev`)).toEqual({ requestHash: HASH, status: null });
    for (const url of [
      `yappr-beta://connect?r=${HASH}`,
      `https://yap.pr/connect/?r=${HASH}`,
      `https://evil.example/devnet/connect/?r=${HASH}`,
      `yappr-dev://post?id=${HASH}`,
      'yappr-dev://connect?r=nothex',
      `/post?id=${HASH}`,
      `/testing/connect/?r=${HASH}`,
    ]) {
      expect(parseAppConnectReturn(url)).toBeNull();
    }
  });

  it('checks at once while the sign-in waits, and reports what the wallet declined', async () => {
    await open({ mode: 'qr' });
    expect(takeAppConnectReturnLink(`yappr-dev://connect?r=${HASH}&ac=ok`)).toBe(true);
    expect(fakeEngine.method('session.appConnectPollNow')).toHaveBeenCalledWith({ requestHash: HASH });
    // A return for a code that was replaced says nothing about this one.
    expect(takeAppConnectReturnLink(`yappr-dev://connect?r=${'cd'.repeat(20)}&ac=declined`)).toBe(true);
    expect(useAppConnect.getState().step.name).toBe('flow');
    act(() => {
      takeAppConnectReturnLink(`yappr-dev://connect?r=${HASH}&ac=declined`);
    });
    expect(screen.getByText('Sign-in declined')).toBeTruthy();
    expect(fakeEngine.method('session.appConnectCancel')).toHaveBeenCalled();
  });

  it('is taken (and ignored) when no sign-in waits', () => {
    expect(takeAppConnectReturnLink(`yappr-dev://connect?r=${HASH}&ac=ok`)).toBe(true);
    expect(fakeEngine.method('session.appConnectPollNow')).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('the wallet session prompts', () => {
  const status = (patch: Record<string, unknown>) =>
    act(() => fakeEngine.emit('session.appConnectStatus', { identityId: alice.identityId, health: 'ok', renewRequired: null, signedOutByWallet: null, ...patch }));

  beforeEach(() => {
    fakeEngine.method('session.appConnectStatus').mockResolvedValue({ identityId: alice.identityId, health: 'ok', renewRequired: null, signedOutByWallet: null });
    fakeEngine.method('session.appConnectDismiss').mockResolvedValue(undefined);
  });

  it('opens "Renew in your wallet" once for a stopped write, and closing it does not open it again', async () => {
    const view = render(<AppConnectNotices ready />);
    await act(async () => {});
    status({ renewRequired: 'allowance-spent' });
    expect(router.push).toHaveBeenCalledWith('/sign-in/renew?reason=allowance-spent');
    expect(fakeEngine.method('session.appConnectDismiss')).toHaveBeenCalledWith({ renewRequired: true });
    const again = () =>
      view.rerender(<SafeAreaProvider initialMetrics={METRICS}><QueryClientProvider client={queryClient}><AppConnectNotices ready /></QueryClientProvider></SafeAreaProvider>);
    // In the prompt, then closed before the engine's "seen" arrives.
    mockPathname = '/sign-in/renew';
    again();
    mockPathname = '/';
    again();
    expect(router.push).toHaveBeenCalledTimes(1);
    // Once the engine forgets the stop, the next stopped write prompts again.
    status({ renewRequired: null });
    status({ renewRequired: 'expired' });
    expect(router.push).toHaveBeenLastCalledWith('/sign-in/renew?reason=expired');
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it('says the wallet signed the account out only once the engine has, and "Sign in" signs that account in again', async () => {
    render(<AppConnectNotices ready />);
    await act(async () => {});
    expect(screen.queryByTestId('wallet-signed-out')).toBeNull();
    status({ identityId: null, signedOutByWallet: alice.identityId });
    expect(afterSignOut).toHaveBeenCalledWith(alice.identityId, true);
    expect(fakeEngine.method('session.appConnectDismiss')).toHaveBeenCalledWith({ signedOut: true });
    expect(screen.getByText('Signed out from your wallet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('wallet-signed-out-sign-in'));
    expect(reauthenticate).toHaveBeenCalledWith(alice.identityId);
  });

  it('reads the standing at once when the engine is already up', async () => {
    fakeEngine.method('session.appConnectStatus').mockResolvedValue({ identityId: alice.identityId, health: 'ok', renewRequired: 'expired', signedOutByWallet: null });
    render(<AppConnectNotices ready />);
    await act(async () => {});
    expect(router.push).toHaveBeenCalledWith('/sign-in/renew?reason=expired');
  });

  it('renews from the low-allowance toast only the account it warned about', async () => {
    render(<AppConnectNotices ready />);
    await act(async () => {});
    status({ health: 'renew-soon' });
    const action = useToastStore.getState().current?.action;
    expect(action).toBeTruthy();
    act(() => useSessionStore.setState({ status: 'signed-in', session: { ...alice, identityId: 'bob' }, accounts: [] }));
    action?.onPress();
    expect(router.push).not.toHaveBeenCalledWith('/sign-in/renew');
    act(() => useSessionStore.setState({ status: 'signed-in', session: alice, accounts: [] }));
    action?.onPress();
    expect(router.push).toHaveBeenCalledWith('/sign-in/renew');
  });

  it('shows no wallet prompt to an account signed in with a key', async () => {
    useSessionStore.setState({ status: 'signed-in', session: { ...alice, method: 'key' }, accounts: [] });
    render(<AppConnectNotices ready />);
    await act(async () => {});
    status({ renewRequired: 'expired' });
    expect(router.push).not.toHaveBeenCalled();
  });

  it('settles a revoke once, however many reports carry it', async () => {
    render(<AppConnectNotices ready />);
    await act(async () => {});
    status({ signedOutByWallet: null });
    status({ identityId: null, signedOutByWallet: alice.identityId });
    status({ identityId: null, signedOutByWallet: alice.identityId });
    expect(afterSignOut).toHaveBeenCalledTimes(1);
    // Once dismissed, a later revoke of the same account (signed in again meanwhile) is a new one.
    status({ signedOutByWallet: null });
    status({ identityId: null, signedOutByWallet: alice.identityId });
    expect(afterSignOut).toHaveBeenCalledTimes(2);
  });
});
