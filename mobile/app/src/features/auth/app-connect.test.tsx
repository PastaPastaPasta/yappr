import type { AppConnectFlowDTO, AppConnectPhaseDTO, SessionDTO } from '@engine/api';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { router } from 'expo-router';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ConnectScreen from '~/app/sign-in/connect';
import { fakeEngine } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';

import { loadSignedInAgain } from './accounts';
import { parseAppConnectReturn, takeAppConnectReturnLink, useAppConnect } from './app-connect';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('./accounts', () => ({
  ...jest.requireActual<typeof import('./accounts')>('./accounts'),
  loadSignedInAgain: jest.fn(async (session: unknown) => session),
}));
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

const flow = (phase: AppConnectPhaseDTO & { flow?: number; renew?: boolean }): AppConnectFlowDTO => ({ flow: 1, renew: false, ...phase });
const waiting = flow({ phase: 'waiting', uri: URI, requestHash: HASH });

async function open(params: Record<string, string>, first: AppConnectFlowDTO = waiting) {
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
    act(() => fakeEngine.emit('session.appConnect', flow({ phase: 'waiting', uri: URI, requestHash: HASH, flow: 1 })));
    expect(screen.getByText(/Someone else may have scanned your code/)).toBeTruthy();
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
    for (const url of [
      `yappr-beta://connect?r=${HASH}`,
      `https://yap.pr/connect/?r=${HASH}`,
      `https://evil.example/devnet/connect/?r=${HASH}`,
      `yappr-dev://post?id=${HASH}`,
      'yappr-dev://connect?r=nothex',
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
