import type { SessionDTO } from '@engine/api';
import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { router } from 'expo-router';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SignInScreen from '~/app/sign-in/index';
import KeySignInScreen from '~/app/sign-in/key';
import RegisterKeysScreen from '~/app/sign-in/register';
import TermsGateScreen from '~/app/terms-gate';
import { useSessionStore } from '~/data/session';
import { fakeEngine } from '~/data/testing/fake-engine';

import { useKeyExchange } from './key-exchange';
import { useTermsStore } from './terms';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));
const mockGoBack = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  Stack: { Screen: () => null },
  useNavigation: () => ({
    getParent: () => ({ canGoBack: () => true, goBack: mockGoBack }),
    addListener: () => () => undefined,
  }),
  useLocalSearchParams: () => ({}),
}));

const KEY = 'cR4tFakeTestKeyThatIsNotRealAtAll1234567890abcdefghijk';
const alice: SessionDTO = {
  identityId: 'AliceIdentity1111111111111111111111111111111',
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: false,
  method: 'key',
};
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const render = (element: ReactElement) => rtlRender(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  fakeEngine.reset();
  useSessionStore.setState({ status: 'signed-out', session: null, accounts: [] });
  useTermsStore.setState({ accepted: {} });
});
afterEach(() => jest.useRealTimers());

describe('private key sign-in (AUTH-08)', () => {
  it('looks the key up after typing stops, shows "Identity found", then signs in and closes', async () => {
    fakeEngine.method('session.checkKey').mockResolvedValue({
      identityId: alice.identityId,
      username: 'alice.dash',
      keyId: 2,
      securityLevel: 2,
    });
    fakeEngine.method('session.signInWithKey').mockResolvedValue(alice);
    render(<KeySignInScreen />);

    expect(screen.getByTestId('key-sign-in').props.accessibilityState.disabled).toBe(true);
    fireEvent.changeText(screen.getByTestId('key-input'), KEY);
    expect(fakeEngine.method('session.checkKey')).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    expect(fakeEngine.method('session.checkKey')).toHaveBeenCalledWith({ key: KEY });
    expect(screen.getByText('Identity found: @alice')).toBeTruthy();
    expect(screen.getByText('Key matches this identity')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('key-sign-in'));
    });
    expect(fakeEngine.method('session.signInWithKey')).toHaveBeenCalledWith({ key: KEY });
    expect(mockGoBack).toHaveBeenCalled();
  });

  it('shows the engine’s reason and keeps Sign in disabled', async () => {
    fakeEngine.method('session.checkKey').mockRejectedValue(coded('KEY_WRONG_NETWORK'));
    render(<KeySignInScreen />);

    fireEvent.changeText(screen.getByTestId('key-input'), KEY);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    expect(screen.getByText('This key is for a different network')).toBeTruthy();
    expect(screen.getByTestId('key-sign-in').props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByTestId('key-retry')).toBeNull();
  });

  it('offers "Try again" when Platform is unavailable', async () => {
    fakeEngine
      .method('session.checkKey')
      .mockRejectedValueOnce(coded('RPC_TIMEOUT'))
      .mockResolvedValueOnce({ identityId: alice.identityId, username: null, keyId: 2, securityLevel: 2 });
    render(<KeySignInScreen />);
    fireEvent.changeText(screen.getByTestId('key-input'), KEY);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('key-retry'));
      jest.advanceTimersByTime(400);
    });
    expect(screen.getByTestId('key-found')).toBeTruthy();
  });

  it('offers to switch to an account already on this device instead of signing in again', async () => {
    useSessionStore.setState({
      accounts: [{ identityId: alice.identityId, username: 'alice', method: 'key', lastUsedAt: new Date(), active: false }],
    });
    fakeEngine.method('session.checkKey').mockResolvedValue({
      identityId: alice.identityId,
      username: 'alice',
      keyId: 2,
      securityLevel: 2,
    });
    render(<KeySignInScreen />);
    fireEvent.changeText(screen.getByTestId('key-input'), KEY);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    expect(screen.getByText('Switch to this account')).toBeTruthy();
  });
});

describe('sign-in methods (AUTH-03, AUTH-05)', () => {
  it('explains a missing wallet and keeps the QR route', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(false);
    render(<SignInScreen />);
    await act(async () => {});

    expect(screen.getByTestId('sign-in-no-wallet')).toBeTruthy();
    expect(screen.queryByTestId('sign-in-open-wallet')).toBeNull();
    fireEvent.press(screen.getByTestId('sign-in-other-device'));
    expect(router.push).toHaveBeenCalledWith('/sign-in/qr');
  });

  it('leads with "Open wallet" when a wallet handles dash-key:, and hides the private key under "Other ways"', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    render(<SignInScreen />);
    await act(async () => {});

    fireEvent.press(screen.getByTestId('sign-in-open-wallet'));
    expect(router.push).toHaveBeenCalledWith('/sign-in/wallet');
    expect(screen.queryByTestId('sign-in-private-key')).toBeNull();
    fireEvent.press(screen.getByTestId('sign-in-other-ways'));
    fireEvent.press(screen.getByTestId('sign-in-private-key'));
    expect(router.push).toHaveBeenCalledWith('/sign-in/key');
    // App Connect is flagged off in 1.0 (AUTH-13).
    expect(screen.queryByTestId('sign-in-app-connect')).toBeNull();
  });
});

describe('key registration (AUTH-06)', () => {
  const pending = { requestId: 'r1', uri: 'dash-key:r1', expiresAt: new Date(Date.now() + 600_000) };
  const registration = { request: pending, uri: 'dash-st:r1', keys: [] };
  it('"Try again" after the request ended goes back to the QR screen for the new request', () => {
    fakeEngine.method('session.startKeyExchange').mockReturnValue(new Promise(() => undefined));
    useKeyExchange.setState({
      mode: 'qr',
      phase: { name: 'error', title: 'Sign-in failed', message: 'Expired', retry: 'start' },
      request: null,
    });
    render(<RegisterKeysScreen />);
    fireEvent.press(screen.getByTestId('kx-try-again'));

    expect(fakeEngine.method('session.startKeyExchange')).toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/sign-in/qr');
    expect(useKeyExchange.getState()).toMatchObject({ mode: 'qr', phase: { name: 'starting' } });
  });

  it('"Try again" after a failed check keeps checking the registration here', () => {
    fakeEngine.method('session.awaitKeyRegistration').mockReturnValue(new Promise(() => undefined));
    useKeyExchange.setState({
      mode: 'wallet',
      phase: { name: 'error', title: 'Sign-in failed', message: 'Offline', retry: 'registration', registration },
      request: pending,
    });
    render(<RegisterKeysScreen />);
    fireEvent.press(screen.getByTestId('kx-try-again'));

    expect(fakeEngine.method('session.awaitKeyRegistration')).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('terms gate (AUTH-09)', () => {
  beforeEach(() => useSessionStore.setState({ status: 'signed-in', session: alice, accounts: [] }));

  it('records acceptance for this identity and network', () => {
    render(<TermsGateScreen />);
    fireEvent.press(screen.getByTestId('terms-agree'));

    expect(Object.values(useTermsStore.getState().accepted)).toHaveLength(1);
    expect(Object.keys(useTermsStore.getState().accepted)[0]).toBe(`devnet-test:${alice.identityId}`);
    expect(router.back).toHaveBeenCalled();
  });

  it('"Not now" signs the account out', async () => {
    fakeEngine.method('session.signOut').mockResolvedValue(undefined);
    fakeEngine.method('session.accounts').mockResolvedValue([]);
    render(<TermsGateScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('terms-not-now'));
    });

    expect(fakeEngine.method('session.signOut')).toHaveBeenCalledWith({ identityId: alice.identityId });
    expect(useTermsStore.getState().accepted).toEqual({});
  });

  it('shows the full community rules on request', () => {
    render(<TermsGateScreen />);
    expect(screen.queryByText('Zero tolerance for abuse')).toBeNull();
    fireEvent.press(screen.getByTestId('terms-community-rules'));
    expect(screen.getByText('Zero tolerance for abuse')).toBeTruthy();
  });
});
