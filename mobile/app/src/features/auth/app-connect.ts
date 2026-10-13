import type { AppConnectFlowDTO, SessionDTO } from '@engine/api';
import { Linking } from 'react-native';
import { create } from 'zustand';

import { config } from '~/config';
import { onEngineEvent } from '~/data/events';
import { engine, engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { syncStorage } from '~/state/storage';

import { loadSignedInAgain } from './accounts';
import { copy } from './copy';
import { walletErrorText } from './errors';
import { networkName } from './onboarding';

/**
 * Wallet sign-in on App Connect builds (docs/APP_CONNECT_PROFILE.md): the
 * screen state of `/sign-in/connect` over the engine's App Connect flow
 * (`session.appConnect*`). The engine makes the request, polls for the
 * wallet's answer and verifies it on chain; this store follows its
 * `session.appConnect` events, opens the wallet, and signs in with the
 * account the user confirms. A renewal is the same flow for the signed-in
 * account only.
 *
 * No countdown is ever shown (signing UX direction): a request the wallet
 * has not answered in its 10 minutes turns into "Check again".
 */

export type AppConnectMode = 'wallet' | 'qr';

export type AppConnectStep =
  | { name: 'idle' }
  | { name: 'starting' }
  /** The engine's flow decides what shows (`flow`). */
  | { name: 'flow' }
  | { name: 'accepting' }
  | { name: 'done'; session: SessionDTO }
  | { name: 'error'; title: string; message: string };

interface AppConnectState {
  mode: AppConnectMode;
  renew: boolean;
  step: AppConnectStep;
  flow: AppConnectFlowDTO | null;
  /** No app on this device opened the wallet link. */
  walletOpenFailed: boolean;
  /** "That's not me" made a fresh request: say why the code changed. */
  rejected: boolean;
}

const initial: AppConnectState = {
  mode: 'wallet',
  renew: false,
  step: { name: 'idle' },
  flow: null,
  walletOpenFailed: false,
  rejected: false,
};

export const useAppConnect = create<AppConnectState>()(() => initial);

const set = (patch: Partial<AppConnectState>) => useAppConnect.setState(patch);
const get = () => useAppConnect.getState();

/** Every async step checks it is still current: a newer action (cancel, start again) supersedes it. */
let generation = 0;
const next = () => ++generation;
const stale = (gen: number) => gen !== generation;

/** The mode of the sign-in in progress, so a relaunch that resumes it reopens the same screen. */
const MODE_KEY = 'yappr.signin.connect-mode';
export const lastAppConnectMode = (): AppConnectMode => (syncStorage.getItem(MODE_KEY) === 'qr' ? 'qr' : 'wallet');

/** Opens the wallet on this device with the current request (`dash-key:` link). */
export function openWallet(): void {
  const flow = get().flow;
  const uri = flow && 'uri' in flow ? flow.uri : null;
  if (!uri) return;
  Linking.openURL(uri).catch((error: unknown) => {
    appendLog('info', 'host', `No app opened the wallet link: ${errorMessage(error)}`);
    set({ walletOpenFailed: true });
  });
}

/** Whether a sign-in or renewal is waiting on the wallet (its return link lands here). */
export function appConnectInProgress(): boolean {
  const { name } = get().step;
  return name === 'starting' || name === 'flow';
}

let listening = false;
/** Wallet mode opens the wallet once the first request of a start is ready. */
let openOnReady = false;
/** The engine epoch the flow runs on: a restarted engine resumes the request. */
let flowEpoch = -1;

function listen(): void {
  if (listening) return;
  listening = true;
  onEngineEvent('session.appConnect', (flow) => {
    const { step, flow: current } = get();
    if (step.name !== 'flow' && step.name !== 'starting') return;
    // A late event of an earlier start.
    if (current && flow.flow < current.flow) return;
    receive(flow);
  });
  engineSupervisor.subscribeStatus(() => {
    const { state, epoch } = engineSupervisor.getStatus();
    if (state !== 'ready' && state !== 'degraded') return;
    if (flowEpoch === -1 || epoch === flowEpoch) return;
    flowEpoch = epoch;
    // The engine restarted under a waiting request: pick the stored request up again.
    if (get().step.name === 'flow') {
      const { mode, renew } = get();
      startAppConnect(mode, { renew, resume: true }).catch(() => undefined);
    }
  });
}

function receive(flow: AppConnectFlowDTO): void {
  if (flow.phase === 'idle') return;
  set({ flow, step: { name: 'flow' } });
  if (flow.phase === 'waiting' && openOnReady) {
    openOnReady = false;
    if (get().mode === 'wallet') openWallet();
  }
}

/**
 * Start a sign-in (or with `renew`, a renewal of the signed-in account).
 * `resume` picks up the request still stored (the app was killed while the
 * wallet was open) and does not open the wallet again; `fresh` makes a new one.
 */
export async function startAppConnect(
  mode: AppConnectMode,
  { renew = false, resume = false, fresh = false }: { renew?: boolean; resume?: boolean; fresh?: boolean } = {},
): Promise<void> {
  listen();
  const gen = next();
  if (!renew) syncStorage.setItem(MODE_KEY, mode);
  openOnReady = !resume;
  set({ ...initial, mode, renew, rejected: get().rejected && fresh, step: { name: 'starting' } });
  try {
    flowEpoch = engineSupervisor.getStatus().epoch;
    const flow = await engine.api.session.appConnectStart({
      renew,
      fresh,
      returnTo: { webBasePath: config.webBasePath, scheme: config.scheme },
    });
    if (stale(gen)) return;
    const current = get().flow;
    if (!current || flow.flow >= current.flow) receive(flow);
  } catch (error) {
    if (stale(gen)) return;
    appendLog('warn', 'host', `Starting the wallet sign-in failed: ${errorMessage(error)}`);
    set({ step: { name: 'error', title: copy.signin.createFailedTitle, message: copy.signin.createFailedBody } });
  }
}

/** Shows the request as a QR code instead (the wallet is on another device), keeping the same request. */
export function switchToQr(): void {
  if (!get().renew) syncStorage.setItem(MODE_KEY, 'qr');
  set({ mode: 'qr', walletOpenFailed: false });
}

/** Poll now: the app came back to the foreground, or the wallet's return link named the request. */
export function pollNow(requestHash?: string): void {
  if (get().step.name !== 'flow') return;
  engine.api.session.appConnectPollNow(requestHash ? { requestHash } : {}).catch((error: unknown) => {
    appendLog('warn', 'host', `Checking for the wallet's answer failed: ${errorMessage(error)}`);
  });
}

/** "Check again" after the request ran out without an answer. */
export async function checkAgain(): Promise<void> {
  openOnReady = get().mode === 'wallet';
  await engine.api.session.appConnectCheckAgain().catch((error: unknown) => {
    appendLog('warn', 'host', `Checking again failed: ${errorMessage(error)}`);
  });
}

/** "That's not me": the engine forgets every answer and makes a new request. */
export async function notMe(): Promise<void> {
  set({ rejected: true });
  openOnReady = false;
  await engine.api.session.appConnectReject().catch((error: unknown) => {
    appendLog('warn', 'host', `Starting over failed: ${errorMessage(error)}`);
  });
}

/**
 * The user confirmed `identityId`: sign in with its grant (or renew). An
 * account that was parked on this device is then loaded again with its
 * other stored keys, as after "Sign in again".
 */
export async function acceptAccount(identityId: string): Promise<void> {
  const gen = next();
  const { renew } = get();
  set({ step: { name: 'accepting' } });
  try {
    const result = await engine.api.session.appConnectAccept({ identityId });
    let { session } = result;
    if (result.status === 'signed-in' && result.reload) session = await loadSignedInAgain(session);
    if (stale(gen)) return;
    set({ step: { name: 'done', session } });
  } catch (error) {
    if (stale(gen)) return;
    appendLog('warn', 'host', `Wallet sign-in failed: ${errorMessage(error)}`);
    set({
      step: {
        name: 'error',
        title: renew ? copy.renew.failed : copy.signin.failed,
        message: /signed in/i.test(errorMessage(error))
          ? walletErrorText(error, networkName)
          : renew ? copy.renew.acceptFailed : copy.connect.acceptFailed,
      },
    });
  }
}

/** The wallet handed the user back saying it did not sign in (`ac=declined`, …). */
function walletReported(status: string): void {
  const text = copy.connect.returned[status as keyof typeof copy.connect.returned] ?? copy.connect.returned.failed;
  next();
  set({ step: { name: 'error', title: text.title, message: text.body } });
  engine.api.session.appConnectCancel().catch(() => undefined);
}

/** "Cancel", or leaving the flow: the engine forgets the request and any answer. */
export function cancelAppConnect(): void {
  const { step } = get();
  next();
  set(initial);
  if (step.name !== 'idle' && step.name !== 'done') {
    engine.api.session.appConnectCancel().catch((error: unknown) => {
      appendLog('warn', 'host', `Cancelling the wallet sign-in failed: ${errorMessage(error)}`);
    });
  }
}

/** The finished state was handed off: forget it without cancelling anything. */
export function resetAppConnect(): void {
  next();
  set(initial);
}

const REQUEST_HASH = /^[0-9a-f]{40}$/;
const STATUS = /^[a-z]{1,16}$/;

/**
 * The wallet's return link, as yap.pr's `/connect` page hands it to the app
 * (`<scheme>://connect?r=…&ac=…`) or, with universal links, the page itself
 * (`https://yap.pr<prefix>/connect/?r=…`). Null for any other link. Nothing
 * in it is trusted: it only says "check now".
 */
export function parseAppConnectReturn(url: string): { requestHash: string; status: string | null } | null {
  const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/i.exec(url.trim());
  if (!match) return null;
  const [, scheme, host = '', path, query = ''] = match;
  const route = `${host}${path}`.replace(/\/+$/, '');
  const ours =
    (scheme.toLowerCase() === config.scheme && (route === 'connect' || route === '/connect')) ||
    (scheme.toLowerCase() === 'https' && host.toLowerCase() === 'yap.pr' && path.replace(/\/+$/, '') === `${config.webBasePath}/connect`);
  if (!ours) return null;
  const params = new Map<string, string>();
  for (const part of query.split('&')) {
    const [key, value = ''] = part.split('=');
    try {
      params.set(decodeURIComponent(key), decodeURIComponent(value));
    } catch {
      return null;
    }
  }
  const requestHash = (params.get('r') ?? '').toLowerCase();
  if (!REQUEST_HASH.test(requestHash)) return null;
  const status = params.get('ac') ?? null;
  return { requestHash, status: status !== null && STATUS.test(status) ? status : null };
}

/**
 * A wallet's return link (`+native-intent`): while a sign-in waits, check
 * at once (or say what the wallet reported) and stay on the waiting screen.
 * True when the link was the wallet's, whether or not anything waits for it.
 */
export function takeAppConnectReturnLink(url: string): boolean {
  const link = parseAppConnectReturn(url);
  if (!link) return false;
  if (!appConnectInProgress()) return true;
  // A return for an earlier request (a code that was replaced) says nothing about this one.
  const flow = get().flow;
  if (flow && 'requestHash' in flow && flow.requestHash !== link.requestHash) return true;
  if (link.status && link.status !== 'ok') walletReported(link.status);
  else pollNow(link.requestHash);
  return true;
}
