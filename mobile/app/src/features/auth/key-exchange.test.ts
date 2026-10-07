import type { KeyExchangeRequestDTO, SessionDTO } from '@engine/api';
import { waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { useExpiredSessions } from '~/data/session-expiry';
import { fakeEngine } from '~/data/testing/fake-engine';

import { finishWalletSwitch, loadSignedInAgain } from './accounts';
import {
  cancelKeyExchange,
  checkAgain,
  checkRegistrationNow,
  continueRegistration,
  currentWalletUri,
  lastKeyExchangeMode,
  POLL_MS,
  retry,
  startKeyExchange,
  takeWalletReturnLink,
  useKeyExchange,
  walletReturned,
} from './key-exchange';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('./accounts', () => ({ finishWalletSwitch: jest.fn(), loadSignedInAgain: jest.fn() }));

const NOW = Date.now();
const request = (id = 'r1', expiresIn = 10 * 60_000): KeyExchangeRequestDTO => ({
  requestId: id,
  uri: `dash-key:${id}?n=d&v=1`,
  expiresAt: new Date(NOW + expiresIn),
});
const session: SessionDTO = {
  identityId: 'id1',
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key-exchange',
};
const remoteError = (code: string, message = code) => Object.assign(new Error(message), { code });
const phase = () => useKeyExchange.getState().phase;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let openURL: jest.SpyInstance;

beforeEach(() => {
  fakeEngine.reset();
  useExpiredSessions.setState({ ids: [] });
  jest.mocked(loadSignedInAgain).mockReset();
  cancelKeyExchange();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  fakeEngine.method('session.cancelKeyExchange').mockResolvedValue(undefined);
});

afterEach(() => openURL.mockRestore());

describe('wallet sign-in', () => {
  it('opens the wallet on this device and polls one run of the platform-auth timeout', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue({ status: 'signed-in', session });

    await startKeyExchange('wallet');

    expect(fakeEngine.method('session.startKeyExchange')).toHaveBeenCalledWith({ reauth: [] });
    expect(openURL).toHaveBeenCalledWith('dash-key:r1?n=d&v=1');
    expect(fakeEngine.method('session.awaitKeyExchange')).toHaveBeenCalledWith('r1', { waitMs: POLL_MS });
    expect(phase()).toEqual({ name: 'signed-in', session });
    expect(loadSignedInAgain).not.toHaveBeenCalled();
  });

  it('asks the engine to log in afresh every account marked "Sign in again", then restarts into it (AUTH-14)', async () => {
    useExpiredSessions.setState({ ids: ['other', 'id1'] });
    const restored = { ...session, username: 'alice (restored)' };
    const loading = deferred<SessionDTO>();
    jest.mocked(loadSignedInAgain).mockReturnValue(loading.promise);
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockImplementation(async () => {
      // The sign-in's session.changed clears the mark before the answer arrives.
      useExpiredSessions.setState({ ids: ['other'] });
      return { status: 'signed-in', session };
    });

    const done = startKeyExchange('qr');
    await waitFor(() => expect(loadSignedInAgain).toHaveBeenCalledWith(session));

    expect(fakeEngine.method('session.startKeyExchange')).toHaveBeenCalledWith({ reauth: ['other', 'id1'] });
    // Busy while the engine restarts, with no request left to poll.
    expect(useKeyExchange.getState()).toMatchObject({ phase: { name: 'starting' }, request: null });
    loading.resolve(restored);
    await done;
    expect(phase()).toEqual({ name: 'signed-in', session: restored });
  });

  it('restarts into an account signed in again after its key registration too (AUTH-14)', async () => {
    useExpiredSessions.setState({ ids: ['id1'] });
    jest.mocked(loadSignedInAgain).mockImplementation(async (s) => s);
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue({
      status: 'needs-registration',
      requestId: 'r1',
      uri: 'dash-st:abc',
      expiresAt: request().expiresAt,
      keys: [],
    });
    fakeEngine.method('session.awaitKeyRegistration').mockImplementation(async () => {
      useExpiredSessions.setState({ ids: [] });
      return { status: 'signed-in', session };
    });

    await startKeyExchange('wallet');
    await continueRegistration();

    expect(loadSignedInAgain).toHaveBeenCalledWith(session);
    expect(phase()).toEqual({ name: 'signed-in', session });
  });

  it('says so when the wallet\'s key is disabled on the identity, and starts over on retry (AUTH-14)', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockRejectedValue(remoteError('KEY_DISABLED', 'engine text'));

    await startKeyExchange('qr');

    expect(phase()).toEqual({
      name: 'error',
      title: 'Sign-in failed',
      message:
        "This wallet's Yappr key was turned off, so it can't sign in. Add a new key from your wallet, or sign in with a private key.",
      retry: 'start',
      registration: undefined,
    });
  });

  it('shows the QR without opening anything', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockReturnValue(new Promise(() => undefined));

    startKeyExchange('qr').catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(openURL).not.toHaveBeenCalled();
    expect(phase()).toEqual({ name: 'waiting', request: request() });
    expect(currentWalletUri(useKeyExchange.getState())).toBe('dash-key:r1?n=d&v=1');
  });

  it('turns a silent timeout into "Check again", which polls the same request while it lives', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue({
      status: 'pending',
      requestId: 'r1',
      expiresAt: request().expiresAt,
    });

    await startKeyExchange('qr');
    expect(phase().name).toBe('no-response');

    await checkAgain(NOW);
    expect(fakeEngine.method('session.startKeyExchange')).toHaveBeenCalledTimes(1);
    expect(fakeEngine.method('session.awaitKeyExchange')).toHaveBeenCalledTimes(2);
  });

  it('makes a fresh request on "Check again" once the old one is about to expire', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValueOnce(request('r1', 5_000)).mockResolvedValueOnce(request('r2'));
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue({ status: 'pending', requestId: 'x', expiresAt: new Date() });

    await startKeyExchange('qr');
    await checkAgain(NOW);

    expect(fakeEngine.method('session.startKeyExchange')).toHaveBeenCalledTimes(2);
    expect(useKeyExchange.getState().request?.requestId).toBe('r2');
  });

  it('treats an expired request as "no response" with nothing to poll', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockRejectedValue(remoteError('KEY_EXCHANGE_TIMEOUT'));

    await startKeyExchange('qr');

    expect(phase()).toEqual({ name: 'no-response', request: null });
  });

  it('resumes the request the engine still holds after a kill, without reopening the wallet', async () => {
    fakeEngine.method('session.pendingKeyExchange').mockResolvedValue(request('kept'));
    fakeEngine.method('session.awaitKeyExchange').mockReturnValue(new Promise(() => undefined));

    startKeyExchange('wallet', { resume: true }).catch(() => undefined);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(fakeEngine.method('session.startKeyExchange')).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
    expect(useKeyExchange.getState().request?.requestId).toBe('kept');
  });

  it('notes when no app opened the wallet link (AUTH-05)', async () => {
    openURL.mockRejectedValue(new Error('No app'));
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockReturnValue(new Promise(() => undefined));

    startKeyExchange('wallet').catch(() => undefined);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(useKeyExchange.getState().walletOpenFailed).toBe(true);
  });

  it('reports a request that could not be created', async () => {
    fakeEngine.method('session.startKeyExchange').mockRejectedValue(remoteError('RPC_TIMEOUT'));

    await startKeyExchange('wallet');

    expect(phase()).toMatchObject({ name: 'error', title: "Couldn't reach your wallet", retry: 'start' });
  });

  it('keeps the approval for "Try again" when Platform is unavailable (AUTH-07)', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine
      .method('session.awaitKeyExchange')
      .mockRejectedValueOnce(remoteError('RPC_TIMEOUT', 'timed out'))
      .mockResolvedValueOnce({ status: 'signed-in', session });

    await startKeyExchange('wallet');
    expect(phase()).toMatchObject({
      name: 'error',
      message: 'Dash Platform is temporarily unavailable. Please try again in a few moments.',
      retry: 'poll',
    });

    await retry();
    expect(fakeEngine.method('session.startKeyExchange')).toHaveBeenCalledTimes(1);
    expect(phase()).toEqual({ name: 'signed-in', session });
  });

  it('switches to an account already on this device when the wallet answers for it', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue({ status: 'switch', identityId: 'id1' });
    jest.mocked(finishWalletSwitch).mockResolvedValueOnce(session).mockResolvedValueOnce(null);

    await startKeyExchange('qr');
    expect(finishWalletSwitch).toHaveBeenCalledWith('id1');
    expect(phase()).toEqual({ name: 'signed-in', session });

    await startKeyExchange('qr');
    expect(phase()).toEqual({
      name: 'error',
      title: 'Sign-in failed',
      message: "Couldn't switch accounts. Please try again.",
      retry: 'start',
    });
    expect(useKeyExchange.getState().request).toBeNull();
  });

  it.each([
    ['before', true],
    ['after', false],
  ])(
    'keeps a switch whose answer arrives after a return to the app polled the same request (repoll fails %s it)',
    async (_, repollFailsFirst) => {
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
      fakeEngine.method('session.awaitKeyExchange').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      jest.mocked(finishWalletSwitch).mockClear().mockResolvedValueOnce(session);
      const flush = async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      };
      // The engine has switched already, so the repoll can only be refused.
      const refuse = () => second.reject(remoteError('RESTART_REQUIRED', 'The engine must restart to finish switching accounts'));

      const started = startKeyExchange('qr');
      await flush();
      walletReturned();
      await flush();
      expect(fakeEngine.method('session.awaitKeyExchange')).toHaveBeenCalledTimes(2);

      if (repollFailsFirst) {
        refuse();
        await flush();
      }
      first.resolve({ status: 'switch', identityId: 'id1' });
      await started;
      if (!repollFailsFirst) refuse();
      await flush();

      expect(finishWalletSwitch).toHaveBeenCalledTimes(1);
      expect(finishWalletSwitch).toHaveBeenCalledWith('id1');
      expect(phase()).toEqual({ name: 'signed-in', session });
    },
  );

  it('drops a switch whose request the user cancelled', async () => {
    const first = deferred<unknown>();
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockReturnValueOnce(first.promise);
    jest.mocked(finishWalletSwitch).mockClear();

    const started = startKeyExchange('qr');
    for (let i = 0; i < 4; i++) await Promise.resolve();
    cancelKeyExchange();
    first.resolve({ status: 'switch', identityId: 'id1' });
    await started;

    expect(finishWalletSwitch).not.toHaveBeenCalled();
    expect(phase().name).toBe('idle');
  });

  it('keeps the approval for "Try again" when the SDK runs out of DAPI nodes', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine
      .method('session.awaitKeyExchange')
      .mockRejectedValueOnce(Object.assign(new Error('no available addresses to retry'), { code: -1 }))
      .mockResolvedValueOnce({ status: 'signed-in', session });

    await startKeyExchange('wallet');
    expect(phase()).toMatchObject({ name: 'error', retry: 'poll' });

    await retry();
    expect(fakeEngine.method('session.startKeyExchange')).toHaveBeenCalledTimes(1);
    expect(phase()).toEqual({ name: 'signed-in', session });
  });

  it('ignores the answer of a poll that a newer one superseded', async () => {
    const first = deferred<unknown>();
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine
      .method('session.awaitKeyExchange')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ status: 'pending', requestId: 'r1', expiresAt: request().expiresAt });

    const started = startKeyExchange('qr');
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await checkAgain(NOW);
    first.reject(remoteError('KEY_EXCHANGE_CANCELLED'));
    await started;

    expect(phase().name).toBe('no-response');
  });

  it('polls again when the engine cancels a poll this app did not cancel', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine
      .method('session.awaitKeyExchange')
      .mockRejectedValueOnce(remoteError('KEY_EXCHANGE_CANCELLED'))
      .mockResolvedValueOnce({ status: 'signed-in', session });

    await startKeyExchange('qr');

    expect(fakeEngine.method('session.awaitKeyExchange')).toHaveBeenCalledTimes(2);
    expect(phase()).toEqual({ name: 'signed-in', session });
  });

  it('makes a fresh request on a return to the app after expiry, without opening the wallet again', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValueOnce(request('r1', 5_000)).mockResolvedValueOnce(request('r2'));
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue({ status: 'pending', requestId: 'x', expiresAt: new Date() });

    await startKeyExchange('wallet');
    expect(openURL).toHaveBeenCalledTimes(1);

    walletReturned();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(useKeyExchange.getState().request?.requestId).toBe('r2');
    expect(openURL).toHaveBeenCalledTimes(1);
  });

  it('abandons a request that was being made when the user cancelled', async () => {
    const created = deferred<KeyExchangeRequestDTO>();
    fakeEngine.method('session.startKeyExchange').mockReturnValue(created.promise);

    const started = startKeyExchange('wallet');
    cancelKeyExchange();
    created.resolve(request('late'));
    await started;

    expect(fakeEngine.method('session.cancelKeyExchange')).toHaveBeenCalledWith('late');
    expect(phase().name).toBe('idle');
    expect(fakeEngine.method('session.awaitKeyExchange')).not.toHaveBeenCalled();
  });

  it('remembers the mode of the request, for a resume after a kill', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockReturnValue(new Promise(() => undefined));

    startKeyExchange('qr').catch(() => undefined);
    expect(lastKeyExchangeMode()).toBe('qr');
    cancelKeyExchange();
    startKeyExchange('wallet').catch(() => undefined);
    expect(lastKeyExchangeMode()).toBe('wallet');
    useKeyExchange.setState({ mode: 'qr' });
    expect(lastKeyExchangeMode()).toBe('qr');
  });

  it('cancels the request in the engine', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockReturnValue(new Promise(() => undefined));
    startKeyExchange('qr').catch(() => undefined);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    cancelKeyExchange();

    expect(fakeEngine.method('session.cancelKeyExchange')).toHaveBeenCalledWith('r1');
    expect(phase()).toEqual({ name: 'idle' });
  });
});

describe('first-login key registration (AUTH-06)', () => {
  const needsRegistration = {
    status: 'needs-registration' as const,
    requestId: 'r1',
    uri: 'dash-st:abc?n=d&v=1',
    expiresAt: request().expiresAt,
    keys: [
      { keyId: 5, purpose: 'authentication' as const, securityLevel: 'high' as const },
      { keyId: 6, purpose: 'encryption' as const, securityLevel: 'medium' as const },
    ],
  };

  it('waits for "Continue in wallet" on this device, then opens dash-st: and checks', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue(needsRegistration);
    fakeEngine
      .method('session.awaitKeyRegistration')
      .mockResolvedValueOnce({ status: 'pending', requestId: 'r1', expiresAt: request().expiresAt })
      .mockResolvedValueOnce({ status: 'signed-in', session });

    await startKeyExchange('wallet');
    expect(phase()).toMatchObject({ name: 'registration', uri: 'dash-st:abc?n=d&v=1' });
    expect(currentWalletUri(useKeyExchange.getState())).toBe('dash-st:abc?n=d&v=1');

    await continueRegistration();

    expect(openURL).toHaveBeenLastCalledWith('dash-st:abc?n=d&v=1');
    expect(fakeEngine.method('session.awaitKeyRegistration')).toHaveBeenCalledTimes(2);
    expect(phase()).toEqual({ name: 'signed-in', session });
  });

  it('shows the registration as a QR across devices and checks at once, "still confirming" after a minute', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue(needsRegistration);
    const second = deferred<unknown>();
    fakeEngine
      .method('session.awaitKeyRegistration')
      .mockResolvedValueOnce({ status: 'pending', requestId: 'r1', expiresAt: request().expiresAt })
      .mockReturnValueOnce(second.promise);

    const started = startKeyExchange('qr');
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(phase()).toMatchObject({ name: 'registering', slow: true });
    second.resolve({ status: 'signed-in', session });
    await started;
    expect(phase()).toEqual({ name: 'signed-in', session });
  });

  it('fails into "Sign-in failed" when the request expires during registration', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue(needsRegistration);
    fakeEngine.method('session.awaitKeyRegistration').mockRejectedValue(remoteError('KEY_REGISTRATION_TIMEOUT', 'This sign-in request expired. Start a new one.'));

    await startKeyExchange('qr');

    expect(phase()).toMatchObject({
      name: 'error',
      title: 'Sign-in failed',
      message: 'This sign-in request expired. Start a new one.',
      retry: 'start',
    });
  });

  it('"Try again" after a failed check keeps checking the signed registration, never asks for it again', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue(needsRegistration);
    fakeEngine
      .method('session.awaitKeyRegistration')
      .mockRejectedValueOnce(remoteError('RPC_TIMEOUT', 'timed out'))
      .mockResolvedValueOnce({ status: 'signed-in', session });

    await startKeyExchange('wallet');
    await continueRegistration();
    expect(phase()).toMatchObject({ name: 'error', retry: 'registration' });

    await retry();
    expect(fakeEngine.method('session.awaitKeyExchange')).toHaveBeenCalledTimes(1);
    expect(fakeEngine.method('session.awaitKeyRegistration')).toHaveBeenCalledTimes(2);
    expect(phase()).toEqual({ name: 'signed-in', session });
  });

  it('"Check now" polls the registration again', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockResolvedValue(needsRegistration);
    fakeEngine.method('session.awaitKeyRegistration').mockReturnValue(new Promise(() => undefined));
    startKeyExchange('qr').catch(() => undefined);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    checkRegistrationNow().catch(() => undefined);
    await Promise.resolve();

    expect(fakeEngine.method('session.awaitKeyRegistration')).toHaveBeenCalledTimes(2);
  });
});

describe('wallet return links', () => {
  it('keeps a waiting sign-in on screen and polls at once', async () => {
    fakeEngine.method('session.startKeyExchange').mockResolvedValue(request());
    fakeEngine.method('session.awaitKeyExchange').mockReturnValue(new Promise(() => undefined));
    startKeyExchange('wallet').catch(() => undefined);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(takeWalletReturnLink('yappr-dev://', false)).toBe(true);
    expect(takeWalletReturnLink('yappr-dev://sign-in?done=1', false)).toBe(true);
    expect(fakeEngine.method('session.awaitKeyExchange')).toHaveBeenCalledTimes(3);
    // Links elsewhere still navigate, and a cold launch link is never taken.
    expect(takeWalletReturnLink('yappr-dev://post?id=abc', false)).toBe(false);
    expect(takeWalletReturnLink('yappr-dev://', true)).toBe(false);
  });

  it('takes nothing when no sign-in is waiting', () => {
    expect(takeWalletReturnLink('yappr-dev://', false)).toBe(false);
  });
});
