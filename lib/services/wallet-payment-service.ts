import { logger } from '@/lib/logger';
import { bytesToBase64, base64ToBytes } from '@/lib/bytes';
import { scopedKey } from '@/lib/storage-scope';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { BatchTransition, StateTransition, TokenDirectPurchaseTransition, TokenTransferTransition, TokenTransition } from '@dashevo/wasm-sdk';
import { getEvoSdk } from './evo-sdk-service';
import { TOKEN_HISTORY_CONTRACT_ID, YAPPR_CONTRACT_ID } from '@/lib/constants';
import { loadReservation, storeWalletPayments } from './identity-nonce';
import { identifierToBase58 } from './sdk-helpers';
import { tipService } from './tip-service';
import { buildUnsignedDirectPurchaseTransition } from './token-purchase-builder';
import { buildUnsignedYappTipTransition } from './token-transfer-builder';
import { restoreWalletTransitionRequest, type WalletTransitionRequest } from './token-transition-builder';
import type { TipTargetKind } from '@/lib/tip-note';

type PaymentOutcome = 'completed' | 'absent' | 'unknown';
type PaymentData =
  | { kind: 'tip'; recipientId: string; amount: string; note?: string }
  | { kind: 'purchase'; amount: string; cost: string };

export interface WalletPayment {
  readonly key: string;
  readonly kind: PaymentData['kind'];
  request: WalletTransitionRequest;
  data: PaymentData;
  checkOutcome: () => Promise<PaymentOutcome>;
}

type PersistedWalletPayment = {
  key: string;
  bytes: string;
  nonce: string;
  reservationId: string;
  data: PaymentData;
};
type PaymentContext = { ownerId: string; key: string; allowAnother?: ReadonlySet<string>; expose?: (payment: WalletPayment) => void; isCurrent?: () => boolean };
type LocalPreparedPayment = { completed: true } | { completed: false; payment?: WalletPayment; unresolved?: true; different?: true };
export type LocalWalletPaymentIntent = {
  key: string;
  cached?: WalletPayment;
  allowAnother?: ReadonlySet<string>;
  onPrepared?: (payment: WalletPayment | undefined) => void;
};
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
  records.push({ key: payment.key, bytes: bytesToBase64(payment.request.bytes), nonce: payment.request.nonce.toString(),
    reservationId: payment.request.reservationId, data: payment.data });
  writePersisted(context.ownerId, records);
}

function receiptFor(ownerId: string, request: WalletTransitionRequest): { id: string; type: string; matches: (document: Record<string, unknown>) => boolean } {
  const transition = StateTransition.fromBytes(request.bytes);
  const batch = BatchTransition.fromStateTransition(transition);
  const batched = batch.transitions;
  try {
    if (batched.length !== 1) throw new Error('Expected one wallet token transition');
    const token = batched[0].toTransition();
    try {
      if (!(token instanceof TokenTransition)) throw new Error('Expected a wallet token transition');
      const id = token.getHistoricalDocumentId(ownerId);
      const tokenId = token.tokenId;
      const detail = token.transition;
      try {
        const expectedToken = tokenId.toBase58();
        let matches: (document: Record<string, unknown>) => boolean;
        if (detail instanceof TokenTransferTransition) {
          const recipient = detail.recipientId;
          let to: string;
          try { to = recipient.toBase58(); } finally { recipient.free(); }
          const amount = detail.amount;
          const note = detail.publicNote ?? '';
          matches = document => identifierToBase58(document.toIdentityId) === to
            && BigInt(String(document.amount)) === amount && (document.publicNote ?? '') === note;
        } else if (detail instanceof TokenDirectPurchaseTransition) {
          const amount = detail.tokenCount;
          // purchaseCost is the actual charge, while totalAgreedPrice is only a ceiling.
          matches = document => BigInt(String(document.tokenAmount)) === amount;
        } else {
          throw new Error('Unsupported wallet token transition');
        }
        return { id: id.toBase58(), type: token.historicalDocumentTypeName,
          matches: document => identifierToBase58(document.tokenId) === expectedToken && matches(document) };
      } finally { detail.free(); tokenId.free(); id.free(); }
    } finally { token.free(); }
  } finally {
    batched.forEach(item => item.free());
    batch.free();
    transition.free();
  }
}

function paymentFor(ownerId: string, request: WalletTransitionRequest, data: PaymentData, key = JSON.stringify([ownerId, data])): WalletPayment {
  const receipt = receiptFor(ownerId, request);
  return {
    key,
    kind: receipt.type === 'transfer' ? 'tip' : 'purchase',
    request,
    data,
    checkOutcome: async () => {
      try {
        const { executable, consumedAt } = await request.checkLiveness();
        if (executable || consumedAt === undefined) return 'unknown';
        const sdk = await getEvoSdk();
        const response = await sdk.documents.getWithProof(TOKEN_HISTORY_CONTRACT_ID, receipt.type, receipt.id);
        const height = response.metadata?.height;
        if (!response.proof || typeof height !== 'bigint' || height <= BigInt(0)) return 'unknown';
        if (response.data) {
          if (receipt.matches(response.data.toObject())) return 'completed';
          // A different receipt at this consumed nonce proves our request can never execute.
          return 'absent';
        }
        return height >= consumedAt ? 'absent' : 'unknown';
      } catch (error) {
        logger.debug('Could not prove the wallet payment receipt:', error);
        return 'unknown';
      }
    },
  };
}

function restorePayment(ownerId: string, record: PersistedWalletPayment): WalletPayment {
  const request = restoreWalletTransitionRequest(ownerId, base64ToBytes(record.bytes), BigInt(record.nonce), record.reservationId);
  return paymentFor(ownerId, request, record.data, record.key);
}

async function reconcilePayment(payment: WalletPayment): Promise<{ outcome: PaymentOutcome; executable: boolean }> {
  const { executable, consumedAt } = await payment.request.checkLiveness();
  const outcome = await payment.checkOutcome();
  if (!executable && consumedAt !== undefined && outcome !== 'unknown') return { outcome, executable };
  return { outcome: 'unknown', executable };
}

export async function prepareWalletPayment(
  cached: WalletPayment | undefined,
  build: (lockHeld?: boolean) => Promise<WalletPayment>,
  context?: PaymentContext
): Promise<PreparedPayment> {
  const result = await preparePayment(cached, build, context);
  if (result.completed) return result;
  if (!result.payment) throw new Error('No wallet payment was built');
  return { ...result, payment: result.payment };
}

export function prepareLocalWalletPayment(cached: WalletPayment | undefined, context: PaymentContext, lockHeld = false) {
  return preparePayment(cached, undefined, context, lockHeld);
}

async function preparePayment(
  cached: WalletPayment | undefined,
  build: ((lockHeld?: boolean) => Promise<WalletPayment>) | undefined,
  context?: PaymentContext,
  lockHeld = false
): Promise<LocalPreparedPayment> {
  const prepare = async (): Promise<LocalPreparedPayment> => {
    let candidate = cached;
    let cachedAbsent = false;
    let reconciliation: Awaited<ReturnType<typeof reconcilePayment>> | undefined;
    if (context) {
      const records = readPersisted(context.ownerId);
      if (cached && !records.some(record => record.reservationId === cached.request.reservationId)) {
        try {
          const result = await reconcilePayment(cached);
          if (result.outcome === 'completed' && cached.key === context.key) return { completed: true };
          cachedAbsent = result.outcome === 'absent';
          if (result.outcome === 'unknown' && !context.allowAnother?.has(cached.request.reservationId)) {
            return { completed: false, payment: cached, unresolved: true, ...(cached.key !== context.key ? { different: true } : {}) };
          }
        } catch (error) {
          logger.debug('Could not reconcile the cached wallet payment:', error);
          return { completed: false, payment: cached, unresolved: true, ...(cached.key !== context.key ? { different: true } : {}) };
        }
      }
      candidate = undefined;
      for (const record of records) {
        const payment = restorePayment(context.ownerId, record);
        let result;
        try { result = await reconcilePayment(payment); }
        catch (error) {
          logger.debug('Could not reconcile the earlier wallet payment:', error);
          result = { outcome: 'unknown' as const, executable: false };
        }
        if (result.outcome === 'completed' || result.outcome === 'absent') {
          writePersisted(context.ownerId, readPersisted(context.ownerId).filter(item => item.reservationId !== record.reservationId));
          const replacesAbsentCached = cachedAbsent && cached && payment.request.nonce > cached.request.nonce;
          if (record.key === context.key && result.outcome === 'completed' && (!cached || cached.key !== context.key || cached.request.reservationId === record.reservationId || replacesAbsentCached)) return { completed: true };
          continue;
        }
        if (context.allowAnother?.has(record.reservationId)) continue;
        if (record.key !== context.key) return { completed: false, payment, unresolved: true, different: true };
        candidate = payment;
        reconciliation = result;
      }
    }
    const create = async (): Promise<LocalPreparedPayment> => {
      if (!build) return { completed: false };
      const built = await build(Boolean(context));
      const payment = context ? { ...built, key: context.key } : built;
      if (context?.isCurrent && !context.isCurrent()) {
        await payment.request.discard(true);
        return { completed: false, payment };
      }
      if (context?.expose) {
        try { persistPayment(payment, context); }
        catch (error) { await payment.request.discard(true); throw error; }
        context.expose(payment);
      }
      return { completed: false, payment };
    };
    if (!candidate) return create();
    try {
      const result = reconciliation ?? await reconcilePayment(candidate);
      if (result.outcome === 'completed') return { completed: true };
      if (result.outcome === 'absent') return create();
      if (context?.expose && (!context.isCurrent || context.isCurrent()) && result.executable) context.expose(candidate);
      return { completed: false, payment: candidate, ...(!result.executable ? { unresolved: true } : {}) };
    } catch (error) {
      logger.debug('Could not reconcile the wallet payment; keeping its request:', error);
      return { completed: false, payment: candidate, unresolved: true };
    }
  };
  return context && !lockHeld ? withIdentityWriteLock(context.ownerId, YAPPR_CONTRACT_ID, prepare) : prepare();
}

export async function buildWalletPurchase(ownerId: string, amount: bigint, cost: bigint, lockHeld = false): Promise<WalletPayment> {
  const request = await buildUnsignedDirectPurchaseTransition(ownerId, amount, cost, lockHeld);
  return paymentFor(ownerId, request, { kind: 'purchase', amount: amount.toString(), cost: cost.toString() });
}

export async function buildWalletTip(
  ownerId: string, recipientId: string, amount: bigint, target?: { kind: TipTargetKind; id: string }, message?: string, lockHeld = false
): Promise<WalletPayment> {
  const note = tipService.tipNoteFor(target, message);
  const request = await buildUnsignedYappTipTransition(ownerId, recipientId, amount, note, lockHeld);
  return paymentFor(ownerId, request, { kind: 'tip', recipientId, amount: amount.toString(), note });
}
