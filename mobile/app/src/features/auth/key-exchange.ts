import type { KeyExchangeRequestDTO, KeyExchangeResultDTO, KeyToRegister, SessionDTO } from '@engine/api';
import { Linking } from 'react-native';
import { create } from 'zustand';

import { errorCode } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { syncStorage } from '~/state/storage';

import { finishWalletSwitch, reauthTarget } from './accounts';
import { copy } from './copy';
import { isTransient, walletErrorText } from './errors';
import { networkName } from './onboarding';

/**
 * Wallet sign-in (PRD AUTH-03 to AUTH-07): the `dash-key:` request, polling
 * for the wallet's answer, and the first-login `dash-st:` key registration.
 * The engine holds the request and its keys (`session.*KeyExchange`); this
 * store is the screen state, shared by the wallet, QR and registration
 * screens and by the wallet-return link.
 *
 * Polling never shows a countdown (signing UX direction): each run lasts the
 * platform-auth timeout and then turns into "Check again" without saying
 * why. A request lives 10 minutes in the engine; the wallet's answer is a
 * document on chain, so a poll within those 10 minutes still finds an answer
 * the wallet published after an earlier run gave up (PRD OQ-11, verified
 * against `mobile/engine/src/session/key-exchange.ts`: `await` re-reads the
 * response by the request's public-key hash, and the request stays
 * resumable until `expiresAt`).
 */

/** One poll run: `DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.timeoutMs`, as web (the host deadline is 130 s). */
export const POLL_MS = 120_000;
/** One registration wait; after the first, the screen says "Still confirming" (AUTH-06) and keeps checking. */
export const REGISTRATION_SLICE_MS = 60_000;
/** A request this close to expiry is replaced, not polled again. */
const EXPIRY_MARGIN_MS = 15_000;

export type KeyExchangeMode = 'wallet' | 'qr';

export type KeyExchangePhase =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'waiting'; request: KeyExchangeRequestDTO }
  /** A poll run ended without an answer; `expired` means "Check again" needs a fresh request. */
  | { name: 'no-response'; request: KeyExchangeRequestDTO | null }
  | { name: 'registration'; request: KeyExchangeRequestDTO; uri: string; keys: KeyToRegister[] }
  | { name: 'registering'; request: KeyExchangeRequestDTO; uri: string; keys: KeyToRegister[]; slow: boolean }
  | { name: 'signed-in'; session: SessionDTO }
  | {
      name: 'error';
      title: string;
      message: string;
      retry: 'start' | 'poll' | 'registration';
      /** With `retry: 'registration'`: the step the wallet already signed, to keep checking (not to sign again). */
      registration?: Registration;
    };

type Registration = { request: KeyExchangeRequestDTO; uri: string; keys: KeyToRegister[] };

interface KeyExchangeState {
  mode: KeyExchangeMode;
  phase: KeyExchangePhase;
  /** The wallet link did not open: no app handles `dash-key:` here (AUTH-05). */
  walletOpenFailed: boolean;
  /** The last live request, kept for "Try again" after a transient failure. */
  request: KeyExchangeRequestDTO | null;
}

const initial: KeyExchangeState = { mode: 'wallet', phase: { name: 'idle' }, walletOpenFailed: false, request: null };

export const useKeyExchange = create<KeyExchangeState>()(() => initial);

/** The mode of the request in progress, so a resume after a kill reopens its screen (QR or wallet). */
const MODE_KEY = 'yappr.signin.mode';
useKeyExchange.subscribe((state, previous) => {
  if (state.phase.name === 'idle') return;
  if (state.mode !== previous.mode || previous.phase.name === 'idle') syncStorage.setItem(MODE_KEY, state.mode);
});

/** The mode of the last request started here (for `pendingKeyExchange` after a kill). */
export const lastKeyExchangeMode = (): KeyExchangeMode => (syncStorage.getItem(MODE_KEY) === 'qr' ? 'qr' : 'wallet');

const set = (patch: Partial<KeyExchangeState>) => useKeyExchange.setState(patch);
const get = () => useKeyExchange.getState();

/** Every async step checks it is still current: a newer action (cancel, check again) supersedes it. */
let generation = 0;
const next = () => ++generation;
const stale = (gen: number) => gen !== generation;

function openLink(uri: string, onFail: () => void): void {
  Linking.openURL(uri).catch((error: unknown) => {
    appendLog('info', 'host', `No app opened the wallet link: ${errorMessage(error)}`);
    onFail();
  });
}

/** Opens the current request in the wallet on this device. */
export function openWallet(): void {
  const uri = get().request?.uri;
  if (uri) openLink(uri, () => set({ walletOpenFailed: true }));
}

function failed(error: unknown, retry: 'start' | 'poll' | 'registration', registration?: Registration): KeyExchangePhase {
  return { name: 'error', title: copy.signin.failed, message: walletErrorText(error, networkName), retry, registration };
}

async function handleStep(gen: number, step: KeyExchangeResultDTO, requestId: string): Promise<void> {
  // The engine has already put a switch's account in place and refuses every session call until it
  // restarts, so a newer poll of the same request (a return to the app) cannot answer in its stead:
  // keep the switch. Only a cancel or a different request drops it.
  const keepSwitch = step.status === 'switch' && get().request?.requestId === requestId;
  if (stale(gen) && !keepSwitch) return;
  if (step.status === 'pending') {
    set({ phase: { name: 'no-response', request: get().request } });
    return;
  }
  if (step.status === 'signed-in') {
    set({ phase: { name: 'signed-in', session: step.session }, request: null });
    return;
  }
  if (step.status === 'switch') {
    // The wallet chose an account already on this device: the engine restarts into it, keys and all.
    // Busy meanwhile, with nothing to poll (a return to the app must not start a new request), and
    // any newer poll's RESTART_REQUIRED superseded.
    const switchGen = next();
    set({ phase: { name: 'starting' }, request: null });
    const session = await finishWalletSwitch(step.identityId);
    if (stale(switchGen)) return;
    set({
      phase: session
        ? { name: 'signed-in', session }
        : { name: 'error', title: copy.signin.failed, message: copy.accounts.switchFailed, retry: 'start' },
    });
    return;
  }
  const request = get().request ?? { requestId: step.requestId, uri: step.uri, expiresAt: step.expiresAt };
  const registration = { request, uri: step.uri, keys: step.keys };
  // A dash-key: link that did not open says nothing about the dash-st: one.
  set({ walletOpenFailed: false });
  if (get().mode === 'qr') {
    // Across devices the wallet scans the registration too: show it and start checking at once.
    await waitForRegistration(gen, { ...registration, slow: false });
  } else {
    set({ phase: { name: 'registration', ...registration } });
  }
}

async function poll(gen: number, request: KeyExchangeRequestDTO, superseded = 0): Promise<void> {
  set({ phase: { name: 'waiting', request }, request });
  try {
    const step = await engine.api.session.awaitKeyExchange(request.requestId, { waitMs: POLL_MS });
    await handleStep(gen, step, request.requestId);
  } catch (error) {
    if (stale(gen)) return;
    const code = errorCode(error);
    // Our own cancel always moves the generation on, so this poll lost to another one in the
    // engine (its polls of one request abort each other): poll again, at most twice.
    if (code === 'KEY_EXCHANGE_CANCELLED' && superseded < 2) {
      await poll(next(), request, superseded + 1);
      return;
    }
    if (code === 'KEY_EXCHANGE_TIMEOUT') {
      // The request expired: "Check again" makes a fresh one.
      set({ phase: { name: 'no-response', request: null }, request: null });
      return;
    }
    appendLog('warn', 'host', `Wallet sign-in failed: ${code ?? errorMessage(error)}`);
    set({ phase: failed(error, isTransient(error) ? 'poll' : 'start') });
  }
}

/**
 * Start a wallet sign-in. `resume` picks up a request the engine still holds
 * (the app was killed while waiting, AUTH-03) instead of making a new one.
 * `open: false` leaves a new request for "Open wallet again" in wallet mode.
 */
export async function startKeyExchange(
  mode: KeyExchangeMode,
  { resume = false, open = true } = {},
): Promise<void> {
  const gen = next();
  set({ ...initial, mode, phase: { name: 'starting' } });
  let request: KeyExchangeRequestDTO;
  try {
    const pending = resume ? await engine.api.session.pendingKeyExchange() : null;
    // Signing an account in again (AUTH-14): the wallet's answer for it logs in, never switches back.
    request = pending ?? (await engine.api.session.startKeyExchange({ reauth: reauthTarget() }));
    // Cancelled while the request was being made: abandon it, or the next launch would resume it.
    if (stale(gen) && get().phase.name === 'idle') abandon(request);
  } catch (error) {
    if (stale(gen)) return;
    appendLog('warn', 'host', `Creating the sign-in request failed: ${errorCode(error) ?? errorMessage(error)}`);
    set({
      phase: {
        name: 'error',
        title: copy.signin.createFailedTitle,
        message: copy.signin.createFailedBody,
        retry: 'start',
      },
    });
    return;
  }
  if (stale(gen)) return;
  set({ request });
  if (mode === 'wallet' && !resume && open) openWallet();
  await poll(gen, request);
}

/**
 * "Check again": poll the same request while it is live, else make a fresh
 * one (AUTH-03). Only the button opens the wallet for it; a return to the
 * app (`open: false`) does not send the user straight back out.
 */
export async function checkAgain(now = Date.now(), { open = true } = {}): Promise<void> {
  const { request, mode } = get();
  if (request && new Date(request.expiresAt).getTime() - now > EXPIRY_MARGIN_MS) {
    await poll(next(), request);
    return;
  }
  await startKeyExchange(mode, { open });
}

/** The primary action of the error state. */
export async function retry(): Promise<void> {
  const { phase, mode, request } = get();
  if (phase.name !== 'error') return;
  if (phase.retry === 'registration') await checkRegistrationNow();
  else if (phase.retry === 'poll' && request) await poll(next(), request);
  else await startKeyExchange(mode);
}

async function waitForRegistration(
  gen: number,
  phase: Omit<Extract<KeyExchangePhase, { name: 'registering' }>, 'name'>,
): Promise<void> {
  let slow = phase.slow;
  for (;;) {
    set({ phase: { name: 'registering', ...phase, slow } });
    try {
      const step = await engine.api.session.awaitKeyRegistration(phase.request.requestId, {
        waitMs: REGISTRATION_SLICE_MS,
      });
      if (step.status !== 'pending') {
        await handleStep(gen, step, phase.request.requestId);
        return;
      }
      if (stale(gen)) return;
      slow = true;
    } catch (error) {
      if (stale(gen)) return;
      appendLog('warn', 'host', `Key registration failed: ${errorCode(error) ?? errorMessage(error)}`);
      const retryable = isTransient(error) && errorCode(error) !== 'KEY_REGISTRATION_TIMEOUT';
      const { request, uri, keys } = phase;
      set({ phase: retryable ? failed(error, 'registration', { request, uri, keys }) : failed(error, 'start') });
      return;
    }
  }
}

/** "Continue in wallet": open the `dash-st:` key registration, then wait for the keys (AUTH-06). */
export async function continueRegistration(): Promise<void> {
  const { phase } = get();
  if (phase.name !== 'registration' && phase.name !== 'registering') return;
  const gen = next();
  set({ walletOpenFailed: false });
  openLink(phase.uri, () => set({ walletOpenFailed: true }));
  await waitForRegistration(gen, { request: phase.request, uri: phase.uri, keys: phase.keys, slow: false });
}

/** "Check now" while the registration confirms, and "Try again" after a check failed. */
export async function checkRegistrationNow(): Promise<void> {
  const { phase } = get();
  if (phase.name === 'registering') {
    await waitForRegistration(next(), { request: phase.request, uri: phase.uri, keys: phase.keys, slow: phase.slow });
  } else if (phase.name === 'error' && phase.registration) {
    // The wallet may have broadcast the registration already: keep checking, never ask to sign it again.
    await waitForRegistration(next(), { ...phase.registration, slow: true });
  }
}

/**
 * The app came back to the foreground, or the wallet returned through a
 * link: poll again at once (AUTH-03).
 */
export function walletReturned(): void {
  const { phase } = get();
  if (phase.name === 'waiting' || phase.name === 'no-response') {
    checkAgain(Date.now(), { open: false }).catch(() => undefined);
  } else if (phase.name === 'registering') {
    checkRegistrationNow().catch(() => undefined);
  }
}

/** `yappr-dev://`, `yappr-dev://sign-in…` or `…/login`: what a wallet opens to hand the user back. */
function isWalletReturn(url: string): boolean {
  const path = url.trim().replace(/^[a-z][a-z0-9+.-]*:/i, '').replace(/^\/+/, '');
  return path === '' || /^[?#]/.test(path) || /^(?:sign-in|login)(?:[/?#]|$)/i.test(path);
}

/**
 * A link that arrives while the wallet sign-in waits (`+native-intent`): a
 * wallet handing the user back keeps them on the waiting screen and polls at
 * once, instead of navigating away. True when the link was taken.
 */
export function takeWalletReturnLink(url: string, initial: boolean): boolean {
  if (initial || !keyExchangeInProgress() || !isWalletReturn(url)) return false;
  walletReturned();
  return true;
}

/** Whether a wallet sign-in is waiting on the user's wallet (a wallet-return link should land here). */
export function keyExchangeInProgress(): boolean {
  const { name } = get().phase;
  return name === 'waiting' || name === 'no-response' || name === 'registration' || name === 'registering';
}

function abandon(request: KeyExchangeRequestDTO): void {
  engine.api.session.cancelKeyExchange(request.requestId).catch((error: unknown) => {
    appendLog('warn', 'host', `Cancelling the sign-in request failed: ${errorMessage(error)}`);
  });
}

/** "Cancel": abandon the request (the engine zeroes its keys) and forget the screen state. */
export function cancelKeyExchange(): void {
  next();
  const { request } = get();
  set(initial);
  if (request) abandon(request);
}

/** The finished state handed off to the terms gate or Home: forget it without cancelling anything. */
export function resetKeyExchange(): void {
  next();
  set(initial);
}

/** The `dash-key:` or `dash-st:` link the wallet should open now, if any. */
export function currentWalletUri(state: KeyExchangeState): string | null {
  const { phase } = state;
  if (phase.name === 'registration' || phase.name === 'registering') return phase.uri;
  return state.request?.uri ?? null;
}
