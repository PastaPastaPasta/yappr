import { logger } from '@/lib/logger';
import { bytesToBase64, base64ToBytes } from '@/lib/bytes';
import { scopedKey } from '@/lib/storage-scope';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { YAPPR_CONTRACT_ID } from '@/lib/constants';
import { loadReservation, storeWalletPayments } from './identity-nonce';
import { tokenService } from './token-service';
import { tipService } from './tip-service';
import { tipHistoryService, matchesSentTip, TIP_PAGE_LIMIT, type SentTipMatch } from './tip-history-service';
import { buildUnsignedDirectPurchaseTransition } from './token-purchase-builder';
import { buildUnsignedYappTipTransition } from './token-transfer-builder';
import { restoreWalletTransitionRequest, type WalletTransitionRequest } from './token-transition-builder';
import type { TipTargetKind } from '@/lib/tip-note';

type PaymentOutcome = 'completed' | 'absent' | 'unknown';
type PaymentData =
  | { kind: 'tip'; recipientId: string; amount: string; note?: string; baselineIds: string[] | null }
  | { kind: 'purchase'; amount: string; cost: string; baseline: string };

export interface WalletPayment {
  request: WalletTransitionRequest;
  data: PaymentData;
  checkOutcome: (consumedAt?: bigint) => Promise<PaymentOutcome>;
}

type PersistedWalletPayment = {
  key: string;
  bytes: string;
  nonce: string;
  reservationId: string;
  data: PaymentData;
};
type PaymentContext = { ownerId: string; key: string; allowAnother?: ReadonlySet<string> };
type PreparedPayment = { completed: true } | { completed: false; payment: WalletPayment; unresolved?: true; different?: true };
const STORAGE_KEY = scopedKey('wallet-payments:v1');

function readPersisted(ownerId: string): PersistedWalletPayment[] {
  const raw = loadReservation(ownerId, YAPPR_CONTRACT_ID)?.walletPayments?.[STORAGE_KEY];
  if (!raw) return [];
  const parsed = JSON.parse(raw) as PersistedWalletPayment[];
  if (!Array.isArray(parsed)) throw new Error('Could not read earlier wallet payments');
  return parsed;
}

function writePersisted(ownerId: string, records: PersistedWalletPayment[]): void {
  storeWalletPayments(ownerId, YAPPR_CONTRACT_ID, STORAGE_KEY, JSON.stringify(records));
}

/** Clear only the resolved payment, leaving other scanned requests available for reconciliation. */
export async function clearPersistedWalletPayment(ownerId: string, reservationId: string): Promise<void> {
  return withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, async () => {
    const records = readPersisted(ownerId);
    if (records.some(record => record.reservationId === reservationId)) writePersisted(ownerId, records.filter(record => record.reservationId !== reservationId));
  });
}

function persistPayment(payment: WalletPayment, context: PaymentContext): void {
  const records = readPersisted(context.ownerId).filter(record => record.reservationId !== payment.request.reservationId);
  records.push({ key: context.key, bytes: bytesToBase64(payment.request.bytes), nonce: payment.request.nonce.toString(),
    reservationId: payment.request.reservationId, data: payment.data });
  writePersisted(context.ownerId, records);
}

function paymentFor(ownerId: string, request: WalletTransitionRequest, data: PaymentData): WalletPayment {
  let completed = false;
  return {
    request,
    data,
    checkOutcome: async (consumedAt) => {
      if (completed) return 'completed';
      if (data.kind === 'purchase') {
        const balance = await tokenService.getBalance(ownerId);
        const baseline = BigInt(data.baseline);
        if (balance >= baseline + BigInt(data.amount)) completed = true;
        if (balance < baseline) data.baseline = balance.toString();
        return completed ? 'completed' : 'unknown';
      }
      if (data.baselineIds === null) return 'unknown';
      try {
        const { tips: sent, height } = await tipHistoryService.getTipsSentWithProof(ownerId);
        if (height === undefined) return 'unknown';
        const baselineIds = data.baselineIds;
        const match: SentTipMatch = { to: data.recipientId, amount: BigInt(data.amount), note: data.note };
        if (sent.some(tip => !baselineIds.includes(tip.id) && matchesSentTip(tip, match))) {
          completed = true;
          return 'completed';
        }
        if (consumedAt === undefined || height < consumedAt || sent.length >= TIP_PAGE_LIMIT) return 'unknown';
        return 'absent';
      } catch (error) {
        logger.debug('Could not prove the wallet tip outcome:', error);
        return 'unknown';
      }
    },
  };
}

function restorePayment(ownerId: string, record: PersistedWalletPayment): WalletPayment {
  const request = restoreWalletTransitionRequest(ownerId, base64ToBytes(record.bytes), BigInt(record.nonce), record.reservationId);
  return paymentFor(ownerId, request, record.data);
}

async function reconcilePayment(payment: WalletPayment): Promise<{ outcome: PaymentOutcome; executable: boolean }> {
  const { executable, consumedAt } = await payment.request.checkLiveness();
  const outcome = await payment.checkOutcome(consumedAt);
  if (outcome === 'completed' || (!executable && consumedAt !== undefined && outcome === 'absent')) return { outcome, executable };
  return { outcome: 'unknown', executable };
}

export async function prepareWalletPayment(
  cached: WalletPayment | undefined,
  build: (lockHeld?: boolean) => Promise<WalletPayment>,
  context?: PaymentContext
): Promise<PreparedPayment> {
  const prepare = async (): Promise<PreparedPayment> => {
    let candidate = cached;
    let reconciliation: Awaited<ReturnType<typeof reconcilePayment>> | undefined;
    if (context) {
      // Storage, rather than a component's stale cache, is authoritative across tabs.
      candidate = undefined;
      for (const record of readPersisted(context.ownerId)) {
        const payment = restorePayment(context.ownerId, record);
        let result;
        try { result = await reconcilePayment(payment); }
        catch (error) {
          logger.debug('Could not reconcile the earlier wallet payment:', error);
          result = { outcome: 'unknown' as const, executable: false };
        }
        if (result.outcome === 'completed' || result.outcome === 'absent') {
          writePersisted(context.ownerId, readPersisted(context.ownerId).filter(item => item.reservationId !== record.reservationId));
          if (record.key === context.key && result.outcome === 'completed') return { completed: true };
          continue;
        }
        if (context.allowAnother?.has(record.reservationId)) continue;
        if (record.key !== context.key) return { completed: false, payment, unresolved: true, different: true };
        candidate = payment;
        reconciliation = result;
      }
    }
    if (!candidate) {
      const payment = await build(Boolean(context));
      if (context) persistPayment(payment, context);
      return { completed: false, payment };
    }
    try {
      const result = reconciliation ?? await reconcilePayment(candidate);
      if (result.outcome === 'completed') return { completed: true };
      if (result.outcome === 'absent') return { completed: false, payment: await build(Boolean(context)) };
      if (context) persistPayment(candidate, context);
      return { completed: false, payment: candidate, ...(!result.executable ? { unresolved: true } : {}) };
    } catch (error) {
      logger.debug('Could not reconcile the wallet payment; keeping its request:', error);
      return { completed: false, payment: candidate, unresolved: true };
    }
  };
  return context ? withIdentityWriteLock(context.ownerId, YAPPR_CONTRACT_ID, prepare) : prepare();
}

export async function buildWalletPurchase(ownerId: string, amount: bigint, cost: bigint, lockHeld = false): Promise<WalletPayment> {
  const baseline = await tokenService.getBalance(ownerId);
  const request = await buildUnsignedDirectPurchaseTransition(ownerId, amount, cost, lockHeld);
  return paymentFor(ownerId, request, { kind: 'purchase', amount: amount.toString(), cost: cost.toString(), baseline: baseline.toString() });
}

export async function buildWalletTip(
  ownerId: string, recipientId: string, amount: bigint, target?: { kind: TipTargetKind; id: string }, message?: string, lockHeld = false
): Promise<WalletPayment> {
  const match = tipService.tipMatch(recipientId, amount, target, message);
  let baselineIds: string[] | null = null;
  try {
    const { tips, height } = await tipHistoryService.getTipsSentWithProof(ownerId);
    if (height !== undefined && tips.length < TIP_PAGE_LIMIT) baselineIds = tips.filter(tip => matchesSentTip(tip, match)).map(tip => tip.id);
  } catch (error) {
    logger.debug('Could not establish the wallet tip baseline:', error);
  }
  const request = await buildUnsignedYappTipTransition(ownerId, recipientId, amount, tipService.tipNoteFor(target, message), lockHeld);
  return paymentFor(ownerId, request, { kind: 'tip', recipientId, amount: amount.toString(), note: match.note, baselineIds });
}
