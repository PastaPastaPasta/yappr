import type { AppConnectFlowDTO } from '@engine/api';
import { create } from 'zustand';

import { config } from '~/config';
import { onEngineEvent } from '~/data/events';
import { errorCode } from '~/data/writes';
import { engine, engineSupervisor } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { syncStorage } from '~/state/storage';

import { loadSignedInAgain } from './accounts';
import { copy } from './copy';
import { walletErrorText } from './errors';
import { openLink } from './key-exchange';
import { networkName } from './onboarding';
import { installedCarriers, pickWalletUri, type WalletCarrierUri } from './wallet-uri';

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
  | { name: 'done' }
  | { name: 'error'; title: string; message: string };

interface AppConnectState {
  mode: AppConnectMode;
  renew: boolean;
  /** Signing this account in again ("Sign in again"): only it may answer. */
  reauth: string | null;
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
  reauth: null,
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

/** The link of the flow's request in the build's default carrier (what the QR code shows), when it has one. */
export const flowUri = (flow: AppConnectFlowDTO | null): string | null => (flow && 'uri' in flow ? flow.uri : null);

/** The request in every carrier the build offers, default first (two on staging builds, else one). */
const flowCarrierUris = (flow: AppConnectFlowDTO | null): readonly WalletCarrierUri[] =>
  flow && 'uris' in flow && flow.uris ? flow.uris : [];

/**
 * Opens the wallet on this device with the current request. Where the build
 * offers both carriers, it is the one whose scheme an installed wallet
 * handles, else `dash-key:`; the request is the same either way.
 */
export function openWallet(): void {
  const flow = get().flow;
  const uri = flowUri(flow);
  if (!uri) return;
  const failed = () => set({ walletOpenFailed: true });
  const options = flowCarrierUris(flow);
  if (options.length < 2) {
    openLink(uri, failed);
    return;
  }
  installedCarriers()
    .then((installed) => {
      // Cancelled, replaced by a new request, or switched to the QR code while the schemes were asked about: open nothing.
      if (get().flow !== flow || get().mode !== 'wallet') return;
      openLink(pickWalletUri(options, installed) ?? uri, failed);
    })
    .catch(() => undefined);
}

/** Whether a sign-in or renewal is waiting on the wallet (its return link lands here). */
export function appConnectInProgress(): boolean {
  const { name } = get().step;
  return name === 'starting' || name === 'flow';
}

let listening = false;
/** Wallet mode opens the wallet once the request of a start is ready, unless that request was opened already. */
let openOnReady = false;
let openedHash: string | null = null;
/** The engine epoch the flow runs on: a restarted engine resumes the request. */
let flowEpoch = -1;
/**
 * The newest flow number seen; events numbered at or below a start's floor
 * belong to an earlier flow. Flows are numbered per engine, so both start
 * over with each engine epoch.
 */
let lastFlow = 0;
let floor = 0;
let numberingEpoch = -1;

/** A new engine numbers its flows from the start again. */
function followEpoch(epoch: number): void {
  if (epoch === numberingEpoch) return;
  numberingEpoch = epoch;
  lastFlow = 0;
  floor = 0;
}

function listen(): void {
  if (listening) return;
  listening = true;
  onEngineEvent('session.appConnect', (flow) => {
    lastFlow = Math.max(lastFlow, flow.flow);
    const { step, flow: current, renew } = get();
    if (step.name !== 'flow' && step.name !== 'starting') return;
    // A late event of an earlier start (or of the other kind of flow).
    if (flow.flow <= floor || (current && flow.flow < current.flow) || flow.renew !== renew) return;
    receive(flow);
  });
  engineSupervisor.subscribeStatus(() => {
    const { state, epoch } = engineSupervisor.getStatus();
    if (state !== 'ready' && state !== 'degraded') return;
    followEpoch(epoch);
    if (flowEpoch === -1 || epoch === flowEpoch) return;
    flowEpoch = epoch;
    // The engine restarted under a waiting request, or while it made one: pick the stored request up again.
    const { step, mode, renew, reauth } = get();
    if (step.name === 'flow' || step.name === 'starting') {
      // A start cut short has not opened the wallet yet.
      const resume = step.name === 'flow' || !openOnReady;
      startAppConnect(mode, { renew, reauth, resume }).catch(() => undefined);
    }
  });
}

function receive(flow: AppConnectFlowDTO): void {
  if (flow.phase === 'idle') return;
  set({ flow, step: { name: 'flow' } });
  if (flow.phase === 'waiting' && openOnReady) {
    openOnReady = false;
    // "Check again" polls the same request while it lasts: the wallet has seen that one already.
    if (get().mode === 'wallet' && flow.requestHash !== openedHash) {
      openedHash = flow.requestHash;
      openWallet();
    }
  }
}

/**
 * Start a sign-in (or with `renew`, a renewal of the signed-in account).
 * `resume` picks up the request still stored (the app was killed while the
 * wallet was open) and does not open the wallet again; `fresh` makes a new one.
 */
export async function startAppConnect(
  mode: AppConnectMode,
  {
    renew = false,
    reauth = null,
    resume = false,
    fresh = false,
  }: { renew?: boolean; reauth?: string | null; resume?: boolean; fresh?: boolean } = {},
): Promise<void> {
  listen();
  followEpoch(engineSupervisor.getStatus().epoch);
  const gen = next();
  syncStorage.setItem(MODE_KEY, mode);
  openOnReady = !resume;
  floor = lastFlow;
  set({ ...initial, mode, renew, reauth: renew ? null : reauth, rejected: get().rejected && fresh, step: { name: 'starting' } });
  try {
    flowEpoch = engineSupervisor.getStatus().epoch;
    const flow = await engine.api.session.appConnectStart({
      renew,
      ...(reauth && !renew ? { reauth } : {}),
      fresh,
      returnTo: { webBasePath: config.webBasePath, scheme: config.scheme },
    });
    if (stale(gen)) return;
    lastFlow = Math.max(lastFlow, flow.flow);
    const current = get().flow;
    if (!current || flow.flow >= current.flow) receive(flow);
  } catch (error) {
    if (stale(gen)) return;
    // The engine restarted under the start: the new engine picks the request up (listen()).
    if (errorCode(error) === 'ENGINE_RESTARTED') return;
    appendLog('warn', 'host', `Starting the wallet sign-in failed: ${errorMessage(error)}`);
    set({ step: { name: 'error', title: copy.signin.createFailedTitle, message: copy.signin.createFailedBody } });
  }
}

/** Shows the request as a QR code instead (the wallet is on another device), keeping the same request. */
export function switchToQr(): void {
  syncStorage.setItem(MODE_KEY, 'qr');
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
  // The rejected accounts can no longer be picked while the new request is made.
  const { flow } = get();
  set({ rejected: true, ...(flow ? { flow: { flow: flow.flow, renew: flow.renew, phase: 'checking' as const } } : {}) });
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
  // One answer, once: a second tap (or another account in the chooser) would only fail after the first signed in.
  if (get().step.name === 'accepting' || get().flow?.phase !== 'confirm') return;
  const gen = next();
  const { renew } = get();
  set({ step: { name: 'accepting' } });
  try {
    const result = await engine.api.session.appConnectAccept({ identityId });
    if (result.status === 'signed-in' && result.reload) await loadSignedInAgain(result.session);
    if (stale(gen)) return;
    set({ step: { name: 'done' } });
  } catch (error) {
    if (stale(gen)) return;
    appendLog('warn', 'host', `Wallet sign-in failed: ${errorMessage(error)}`);
    // Refused because an account is signed in already: say so; anything else, start over.
    const slotTaken = errorCode(error) === 'BAD_REQUEST' && /signed in/i.test(errorMessage(error));
    let message: string = renew ? copy.renew.acceptFailed : copy.connect.acceptFailed;
    if (slotTaken) message = walletErrorText(error, networkName);
    set({ step: { name: 'error', title: renew ? copy.renew.failed : copy.signin.failed, message } });
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
 * (`https://yap.pr<prefix>/connect/?r=…`), or either one in path form
 * (`/connect?r=…`, `<prefix>/connect/?r=…`). Null for any other link.
 * Nothing in it is trusted: it only says "check now".
 */
export function parseAppConnectReturn(url: string): { requestHash: string; status: string | null } | null {
  const trimmed = url.trim();
  const pathForm = /^(\/[^?#]*)(?:\?([^#]*))?/.exec(trimmed);
  const match = pathForm ? null : /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/i.exec(trimmed);
  let ours: boolean;
  let query: string;
  if (pathForm) {
    const route = pathForm[1].replace(/\/+$/, '');
    ours = route === '/connect' || route === `${config.webBasePath}/connect`;
    query = pathForm[2] ?? '';
  } else if (match) {
    const [, scheme, host = '', path] = match;
    const route = `${host}${path}`.replace(/\/+$/, '');
    ours =
      (scheme.toLowerCase() === config.scheme && (route === 'connect' || route === '/connect')) ||
      (scheme.toLowerCase() === 'https' && host.toLowerCase() === 'yap.pr' && path.replace(/\/+$/, '') === `${config.webBasePath}/connect`);
    query = match[4] ?? '';
  } else {
    return null;
  }
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
  // Only a return for the request on screen says anything; a code that was replaced, or none yet, is ignored.
  const flow = get().flow;
  if (!flow || !('requestHash' in flow) || flow.requestHash !== link.requestHash) return true;
  if (link.status && link.status !== 'ok') walletReported(link.status);
  else pollNow(link.requestHash);
  return true;
}
