/**
 * The wallet payment QR this browser last showed for an identity. While its
 * nonce may still execute no other payment is built (`awaitPaymentNonce`), so
 * it is kept here to show that same QR again, or to say which payment is
 * holding a new one back.
 */

import { logger } from '@/lib/logger';
import { YAPPR_CONTRACT_ID } from '../constants';
import { getEvoSdk } from './evo-sdk-service';
import { WALLET_TOKEN_SCOPE, loadReservation, stillPending } from './identity-nonce';
import type { SentTipMatch } from './tip-history-service';

export interface ShownPaymentRequest {
  /** Which payment it is: the same key shows the same QR again. */
  key: string;
  uri: string;
  nonce: bigint;
  /** What it pays, for the user: "5 YAPP to alice", "0.0100 DASH to buy 100 YAPP". */
  description: string;
  /** A tip's proof: its transfer document. */
  tip?: SentTipMatch;
  /** A purchase's proof: the YAPP balance before it grew by `amount`. */
  purchase?: { balanceBefore: bigint; amount: bigint };
}

export type ShownRequestCheck =
  | { kind: 'none' }
  | { kind: 'same' | 'held' | 'settled'; request: ShownPaymentRequest };

const PREFIX = 'yappr:wallet-payment-request:';

const storageKey = (ownerId: string) => `${PREFIX}${ownerId}:${YAPPR_CONTRACT_ID}`;

export function heldRequestMessage(request: ShownPaymentRequest): string {
  return `You have an unpaid payment request open. Pay it in your wallet first; it was for ${request.description}.`;
}

/** Best effort: without it a payment is still held back, only without its QR to show again. */
export function saveShownRequest(ownerId: string, request: ShownPaymentRequest): void {
  try {
    const { nonce, tip, purchase, ...rest } = request;
    localStorage.setItem(storageKey(ownerId), JSON.stringify({
      ...rest,
      nonce: nonce.toString(),
      ...(tip ? { tip: { ...tip, amount: tip.amount.toString() } } : {}),
      ...(purchase ? { purchase: { balanceBefore: purchase.balanceBefore.toString(), amount: purchase.amount.toString() } } : {}),
    }));
  } catch (error) {
    logger.warn('Could not store the wallet payment request:', error);
  }
}

export function loadShownRequest(ownerId: string): ShownPaymentRequest | null {
  try {
    const raw = localStorage.getItem(storageKey(ownerId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Omit<ShownPaymentRequest, 'nonce' | 'tip' | 'purchase'> & {
      nonce: string;
      tip?: Omit<SentTipMatch, 'amount'> & { amount: string };
      purchase?: { balanceBefore: string; amount: string };
    };
    const { nonce, tip, purchase, ...rest } = stored;
    return {
      ...rest,
      nonce: BigInt(nonce),
      ...(tip ? { tip: { ...tip, amount: BigInt(tip.amount) } } : {}),
      ...(purchase ? { purchase: { balanceBefore: BigInt(purchase.balanceBefore), amount: BigInt(purchase.amount) } } : {}),
    };
  } catch (error) {
    logger.warn('Could not read the wallet payment request:', error);
    return null;
  }
}

/** Forget the request stored under `key`, never a newer one stored since. */
export function clearShownRequest(ownerId: string, key: string): void {
  try {
    if (loadShownRequest(ownerId)?.key === key) localStorage.removeItem(storageKey(ownerId));
  } catch (error) {
    logger.warn('Could not clear the wallet payment request:', error);
  }
}

/**
 * Where the payment `key` stands against the stored request: `same` when it is
 * that request and its nonce may still execute (show its QR again), `held`
 * when a different one may, `settled` when it is that request and its nonce
 * can no longer execute (paid or overtaken: the caller looks for its proof),
 * and `none` when nothing stored stands in the way.
 */
export async function checkShownRequest(ownerId: string, key: string): Promise<ShownRequestCheck> {
  const request = loadShownRequest(ownerId);
  if (!request) return { kind: 'none' };
  const sdk = await getEvoSdk();
  const current = await sdk.identities.contractNonce(ownerId, YAPPR_CONTRACT_ID);
  const live = stillPending(current, loadReservation(ownerId, YAPPR_CONTRACT_ID))
    .some((entry) => entry.scope === WALLET_TOKEN_SCOPE && entry.nonce === request.nonce);
  if (live) return { kind: request.key === key ? 'same' : 'held', request };
  if (request.key === key) return { kind: 'settled', request };
  clearShownRequest(ownerId, request.key);
  return { kind: 'none' };
}

export type PurchaseRequestCheck =
  | Exclude<ShownRequestCheck, { kind: 'settled' }>
  | { kind: 'paid'; balance: bigint }
  | { kind: 'unproven' };

/**
 * {@link checkShownRequest} for a purchase, settling a request whose nonce can
 * no longer execute: `paid` once the YAPP balance shows it (read a few times,
 * so a node that is behind can't hide it), otherwise `unproven`, which keeps
 * the request stored: YAPP spent since can hide a purchase that went through,
 * so nothing new is built until the user clears it.
 */
export async function checkPurchaseRequest(
  ownerId: string,
  key: string,
  readBalance: () => Promise<bigint>,
  { attempts = 5, delayMs = 3000 } = {}
): Promise<PurchaseRequestCheck> {
  const shown = await checkShownRequest(ownerId, key);
  if (shown.kind !== 'settled') return shown;
  const paid = shown.request.purchase;
  for (let attempt = 0; paid && attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const balance = await readBalance();
      if (balance >= paid.balanceBefore + paid.amount) return { kind: 'paid', balance };
    } catch (error) {
      logger.debug('Could not read the balance a purchase would show, retrying', error);
    }
  }
  return { kind: 'unproven' };
}
