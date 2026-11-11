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
  checkOutcome: () => Promise<PaymentOutcome>;
}

type PreparedPayment = { completed: true } | { completed: false; payment: WalletPayment };

export async function prepareWalletPayment(
  cached: WalletPayment | undefined,
  build: () => Promise<WalletPayment>
): Promise<PreparedPayment> {
  if (!cached) return { completed: false, payment: await build() };
  try {
    // Read liveness first: absence read before expiry could miss a late wallet broadcast.
    const executable = await cached.request.isExecutable();
    const outcome = await cached.checkOutcome();
    if (outcome === 'completed') return { completed: true };
    if (!executable && outcome === 'absent') return { completed: false, payment: await build() };
  } catch (error) {
    logger.debug('Could not reconcile the wallet payment; keeping its request:', error);
  }
  return { completed: false, payment: cached };
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
      return completed ? 'completed' : 'absent';
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
    checkOutcome: async () => {
      if (completed) return 'completed';
      const sent = await tipHistoryService.getTipsSent(ownerId, { fresh: true });
      if (sent.some(tip => matchesSentTip(tip, match))) {
        completed = true;
        return 'completed';
      }
      // A full page that does not reach this request's start cannot prove absence.
      if (sent.length >= TIP_PAGE_LIMIT && !sent.some(tip => tip.createdAt.getTime() < (match.since ?? 0))) return 'unknown';
      return 'absent';
    },
  };
}
