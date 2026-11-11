import { logger } from '@/lib/logger';
import { tokenService } from './token-service';
import { tipService } from './tip-service';
import { tipHistoryService, matchesSentTip, TIP_PAGE_LIMIT } from './tip-history-service';
import { buildUnsignedDirectPurchaseTransition } from './token-purchase-builder';
import { buildUnsignedYappTipTransition } from './token-transfer-builder';
import type { WalletTransitionRequest } from './token-transition-builder';
import type { TipTargetKind } from '@/lib/tip-note';

type PaymentOutcome = 'completed' | 'absent' | 'unknown';

export interface WalletPayment {
  request: WalletTransitionRequest;
  checkOutcome: (consumedAt?: bigint) => Promise<PaymentOutcome>;
}

type PreparedPayment = { completed: true } | { completed: false; payment: WalletPayment; unresolved?: true };

export async function prepareWalletPayment(
  cached: WalletPayment | undefined,
  build: () => Promise<WalletPayment>
): Promise<PreparedPayment> {
  if (!cached) return { completed: false, payment: await build() };
  try {
    const { executable, consumedAt } = await cached.request.checkLiveness();
    const outcome = await cached.checkOutcome(consumedAt);
    if (outcome === 'completed') return { completed: true };
    if (!executable && consumedAt !== undefined && outcome === 'absent') return { completed: false, payment: await build() };
    if (executable) return { completed: false, payment: cached };
  } catch (error) {
    logger.debug('Could not reconcile the wallet payment; keeping its request:', error);
  }
  return { completed: false, payment: cached, unresolved: true };
}

export async function buildWalletPurchase(ownerId: string, amount: bigint, cost: bigint): Promise<WalletPayment> {
  let baseline = await tokenService.getBalance(ownerId);
  const request = await buildUnsignedDirectPurchaseTransition(ownerId, amount, cost);
  let completed = false;
  return {
    request,
    checkOutcome: async () => {
      if (completed) return 'completed';
      const balance = await tokenService.getBalance(ownerId);
      if (balance >= baseline + amount) completed = true;
      if (balance < baseline) baseline = balance;
      return completed ? 'completed' : 'unknown';
    },
  };
}

export async function buildWalletTip(
  ownerId: string,
  recipientId: string,
  amount: bigint,
  target?: { kind: TipTargetKind; id: string },
  message?: string
): Promise<WalletPayment> {
  const match = tipService.tipMatch(recipientId, amount, target, message, Date.now() - 60_000);
  const request = await buildUnsignedYappTipTransition(ownerId, recipientId, amount, tipService.tipNoteFor(target, message));
  let completed = false;
  return {
    request,
    checkOutcome: async (consumedAt) => {
      if (completed) return 'completed';
      try {
        const { tips: sent, height } = await tipHistoryService.getTipsSentWithProof(ownerId);
        if (height === undefined) return 'unknown';
        if (sent.some(tip => matchesSentTip(tip, match))) {
          completed = true;
          return 'completed';
        }
        if (consumedAt === undefined || height < consumedAt) return 'unknown';
        // A full page that does not reach this request's start cannot prove absence.
        if (sent.length >= TIP_PAGE_LIMIT && !sent.some(tip => tip.createdAt.getTime() < (match.since ?? 0))) return 'unknown';
        return 'absent';
      } catch (error) {
        logger.debug('Could not prove the wallet tip outcome:', error);
        return 'unknown';
      }
    },
  };
}
