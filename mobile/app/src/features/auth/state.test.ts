import {
  appStateChanged,
  lockLabel,
  setAppLockEnabled,
  unlock,
  untilUnlocked,
  useAppLockSettings,
  useLockState,
} from './app-lock';
import { isTransient, keyErrorText, walletErrorText } from './errors';
import { acceptTerms, hasAcceptedTerms, TERMS_VERSION, useTermsStore } from './terms';

jest.mock('expo-local-authentication', () => ({
  authenticateAsync: jest.fn(async () => ({ success: true })),
  getEnrolledLevelAsync: jest.fn(async () => 3),
  supportedAuthenticationTypesAsync: jest.fn(async () => [2]),
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

const LocalAuthentication = jest.requireMock('expo-local-authentication');
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

describe('terms gate records (AUTH-09)', () => {
  beforeEach(() => useTermsStore.setState({ accepted: {} }));

  it('is per identity and per network, for the current version only', () => {
    acceptTerms('devnet-sakura', 'alice');

    expect(hasAcceptedTerms('devnet-sakura', 'alice')).toBe(true);
    expect(hasAcceptedTerms('devnet-sakura', 'bob')).toBe(false);
    expect(hasAcceptedTerms('testnet', 'alice')).toBe(false);

    // A version bump shows the gate again.
    useTermsStore.setState({ accepted: { 'devnet-sakura:alice': { version: 'old', acceptedAt: 1 } } });
    expect(hasAcceptedTerms('devnet-sakura', 'alice')).toBe(false);
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('app lock (AUTH-12)', () => {
  beforeEach(() => {
    useAppLockSettings.setState({ enabled: true, timeoutMs: 60_000 });
    useLockState.setState({ locked: false, covered: false, authenticating: false, backgroundAt: null });
    LocalAuthentication.authenticateAsync.mockResolvedValue({ success: true });
  });

  it('covers the app while inactive, so the switcher snapshot shows no content', () => {
    appStateChanged('inactive', 1000);
    expect(useLockState.getState()).toMatchObject({ covered: true, locked: false });
    appStateChanged('active', 1500);
    expect(useLockState.getState()).toMatchObject({ covered: false, locked: false });
  });

  it('locks on return once the app was in the background for the timeout', () => {
    appStateChanged('background', 0);
    appStateChanged('active', 59_000);
    expect(useLockState.getState().locked).toBe(false);

    appStateChanged('background', 100_000);
    appStateChanged('active', 160_000);
    expect(useLockState.getState().locked).toBe(true);
  });

  it('"Immediately" locks on any return from the background', () => {
    useAppLockSettings.setState({ timeoutMs: 0 });
    appStateChanged('background', 0);
    appStateChanged('active', 1);
    expect(useLockState.getState().locked).toBe(true);
  });

  it('ignores the inactive state the OS prompt itself causes', () => {
    useLockState.setState({ authenticating: true, locked: true });
    appStateChanged('inactive', 0);
    expect(useLockState.getState().covered).toBe(false);
  });

  it('does nothing when off', () => {
    useAppLockSettings.setState({ enabled: false });
    appStateChanged('background', 0);
    appStateChanged('active', 10_000_000);
    expect(useLockState.getState()).toMatchObject({ locked: false, covered: false });
  });

  it('turns on only after one successful check; off needs none', async () => {
    useAppLockSettings.setState({ enabled: false });
    LocalAuthentication.authenticateAsync.mockResolvedValueOnce({ success: false });
    await expect(setAppLockEnabled(true)).resolves.toBe(false);
    expect(useAppLockSettings.getState().enabled).toBe(false);

    await expect(setAppLockEnabled(true)).resolves.toBe(true);
    expect(useAppLockSettings.getState().enabled).toBe(true);

    LocalAuthentication.authenticateAsync.mockClear();
    await setAppLockEnabled(false);
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  });

  it('holds the engine\'s secret hydration until the owner unlocks (SR-39, ENGINE.md §9.2)', async () => {
    const settled = jest.fn();
    untilUnlocked().then(settled, settled);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);

    useLockState.setState({ locked: true });
    settled.mockClear();
    untilUnlocked().then(settled, settled);
    LocalAuthentication.authenticateAsync.mockResolvedValueOnce({ success: false });
    await unlock();
    expect(settled).not.toHaveBeenCalled();

    await unlock();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('names the biometric the device has', () => {
    expect(lockLabel([2])).toBe('Require Face ID');
    expect(lockLabel([1])).toBe('Require Touch ID');
    expect(lockLabel([])).toBe('Require device passcode');
  });
});

describe('sign-in error copy (AUTH-07, AUTH-08)', () => {
  it('maps the engine key codes to the web wording', () => {
    expect(keyErrorText(coded('KEY_INVALID'))).toBe('Invalid private key');
    expect(keyErrorText(coded('KEY_WRONG_NETWORK'))).toBe('This key is for a different network');
    expect(keyErrorText(coded('IDENTITY_NOT_FOUND'))).toBe('No identity uses this key');
    expect(keyErrorText(coded('KEY_NOT_ON_IDENTITY', 'This key has been disabled on this identity'))).toBe(
      'This key has been disabled on this identity',
    );
    expect(keyErrorText(coded('RPC_TIMEOUT'))).toBe(
      'Dash Platform is temporarily unavailable. Please try again in a few moments.',
    );
  });

  it('names the network in wallet failures', () => {
    expect(walletErrorText(new Error('Identity not found'), 'Devnet')).toBe(
      'No identity was found for this wallet on Devnet.',
    );
    expect(walletErrorText(new Error('network mismatch'), 'Devnet')).toBe(
      'This wallet is on a different network. Switch your wallet to Devnet and try again.',
    );
  });

  it('tells transient failures from bad input', () => {
    expect(isTransient(coded('ENGINE_RESTARTED'))).toBe(true);
    expect(isTransient(new Error('Quorum not found in cache'))).toBe(true);
    expect(isTransient(coded('KEY_INVALID'))).toBe(false);
  });

  it('counts an SDK that ran out of DAPI nodes as transient', () => {
    // DapiClientError carries a numeric code, which is not an engine code.
    const exhausted = (message: string) => Object.assign(new Error(message), { code: -1 });
    expect(isTransient(exhausted('no available addresses to use'))).toBe(true);
    expect(isTransient(exhausted('no available addresses to retry, last error: deadline exceeded'))).toBe(true);
    expect(keyErrorText(exhausted('no available addresses to retry'))).toBe(
      'Dash Platform is temporarily unavailable. Please try again in a few moments.',
    );
  });
});
