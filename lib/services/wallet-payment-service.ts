import { logger } from '@/lib/logger';
import { bytesToBase64, base64ToBytes } from '@/lib/bytes';
import { scopedKey } from '@/lib/storage-scope';
import { withIdentityWriteLock } from '@/lib/identity-write-lock';
import { BatchTransition, StateTransition, TokenDirectPurchaseTransition, TokenTransferTransition, TokenTransition } from '@dashevo/wasm-sdk';
import { getEvoSdk } from './evo-sdk-service';
import { TOKEN_HISTORY_CONTRACT_ID, YAPPR_CONTRACT_ID } from '@/lib/constants';
import { loadWalletPayments, storeWalletPayments } from './identity-nonce';
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
  /** The token-history document the payment writes when it executes. */
  readonly receiptId: string;
  request: WalletTransitionRequest;
  data: PaymentData;
  checkOutcome: () => Promise<PaymentOutcome>;
  /** One read of the request's nonce, and the outcome that same read proves: never a later outcome against an earlier liveness. */
  observe: () => Promise<PaymentObservation>;
}

type PaymentObservation = { outcome: PaymentOutcome; executable: boolean };

/**
 * What a local payment that replaced a request proved absent did: kept on the
 * request, so a tab still showing its QR code settles by it instead of showing
 * a fresh one. `sending` until the write's answer (or for good, when its page
 * died meanwhile: it may have gone through).
 */
export type ReplacementState = 'sending' | 'completed' | 'failed';

type PersistedWalletPayment = {
  key: string;
  bytes: string;
  nonce: string;
  reservationId: string;
  data: PaymentData;
  replacedBy?: { state: ReplacementState; at: number };
};
type PaymentContext = {
  ownerId: string;
  key: string;
  allowAnother?: ReadonlySet<string>;
  expose?: (payment: WalletPayment) => void;
  isCurrent?: () => boolean;
  /** The local confirmation this prepares ({@link beginLocalWalletPayment}). */
  attemptId?: string;
};
/**
 * `replaces`: for a local payment that goes ahead at a fresh nonce, the
 * requests of the same payment proved absent that it replaces, to be marked
 * ({@link markReplacedWalletPayments}) before it is signed.
 */
type LocalPreparedPayment = { completed: true } | { completed: false; payment?: WalletPayment; unresolved?: true; different?: true; replaces?: string[] };
export type LocalWalletPaymentIntent = {
  key: string;
  cached?: WalletPayment;
  allowAnother?: ReadonlySet<string>;
  onPrepared?: (payment: WalletPayment | undefined) => void;
  attemptId?: string;
};
type PreparedPayment = { completed: true } | { completed: false; payment: WalletPayment; unresolved?: true; different?: true };
const STORAGE_KEY = scopedKey('wallet-payments:v1');

/**
 * A local confirmation of a payment under way, recorded before its CRITICAL
 * signer is asked for and kept until it ends. While the key sheet waits,
 * another tab may show the same payment's QR, see the wallet complete it and
 * clear its record: that tab stamps the completed reservation and receipt
 * here, so this confirmation settles as completed instead of paying again at
 * a fresh nonce. A payment completed before the attempt began never stamps
 * it, so a genuinely new payment of the same amount still goes through, and
 * one the user explicitly asked to send again (`allowAnother`) ignores it.
 */
type PaymentSettlement = { reservationId: string; receiptId?: string };
type PaymentAttempt = { id: string; key: string; startedAt: number; settledBy?: PaymentSettlement[] };
/** Ended in `finally`: only a page that died mid-attempt leaves one behind, and it signs nothing. */
const ATTEMPT_LIFETIME_MS = 24 * 60 * 60_000;
const attemptsKey = (ownerId: string) => scopedKey(`wallet-payment-attempts:v1:${ownerId}`);

function readAttempts(ownerId: string): PaymentAttempt[] {
  const raw = localStorage.getItem(attemptsKey(ownerId));
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  // Unreadable: read as none, so it is overwritten; an attempt it held reads as gone and signs nothing.
  if (!Array.isArray(parsed)) return [];
  const now = Date.now();
  return (parsed as PaymentAttempt[]).filter(attempt => now - attempt.startedAt < ATTEMPT_LIFETIME_MS);
}

function writeAttempts(ownerId: string, attempts: PaymentAttempt[]): void {
  localStorage.setItem(attemptsKey(ownerId), JSON.stringify(attempts));
}

/**
 * Under the write lock: starts a local confirmation of the payment `key`.
 * Rejects when it can't be recorded, so nothing is signed without it.
 */
export function beginLocalWalletPayment(ownerId: string, key: string): Promise<string> {
  return withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, async () => {
    const id = crypto.randomUUID();
    writeAttempts(ownerId, [...readAttempts(ownerId), { id, key, startedAt: Date.now() }]);
    return id;
  });
}

/** Ends a local confirmation, whatever its outcome. */
export function endLocalWalletPayment(ownerId: string, attemptId: string): Promise<void> {
  return withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, async () => {
    const attempts = readAttempts(ownerId);
    writeAttempts(ownerId, attempts.filter(attempt => attempt.id !== attemptId));
  });
}

/**
 * Under the write lock: a completed payment settles every confirmation of the
 * same payment still under way. Each completion is kept, with the receipt it
 * wrote, so one the user chose to send past never hides a later one.
 */
function settleAttempts(ownerId: string, record: PersistedWalletPayment): void {
  const attempts = readAttempts(ownerId);
  const settles = (attempt: PaymentAttempt) => attempt.key === record.key
    && !attempt.settledBy?.some(item => item.reservationId === record.reservationId);
  if (!attempts.some(settles)) return;
  let receiptId: string | undefined;
  try {
    receiptId = restorePayment(ownerId, record).receiptId;
  } catch (error) {
    logger.debug('Could not read the completed wallet payment receipt:', error);
  }
  const settlement: PaymentSettlement = { reservationId: record.reservationId, ...(receiptId ? { receiptId } : {}) };
  writeAttempts(ownerId, attempts.map(attempt => (settles(attempt) ? { ...attempt, settledBy: [...(attempt.settledBy ?? []), settlement] } : attempt)));
}

/** Whether a local confirmation was settled by a completed payment, or can no longer be told apart (gone). */
function attemptSettled(context: PaymentContext): 'settled' | 'gone' | null {
  if (!context.attemptId) return null;
  const attempt = readAttempts(context.ownerId).find(item => item.id === context.attemptId);
  if (!attempt) return 'gone';
  const settlement = attempt.settledBy?.find(item => !context.allowAnother?.has(item.reservationId));
  if (!settlement) return null;
  logger.info(`Wallet payment settled by ${settlement.reservationId}${settlement.receiptId ? ` (receipt ${settlement.receiptId})` : ''} during a local confirmation`);
  return 'settled';
}

function readPersisted(ownerId: string): PersistedWalletPayment[] {
  const raw = loadWalletPayments(ownerId, YAPPR_CONTRACT_ID, STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as PersistedWalletPayment[];
  if (!Array.isArray(parsed)) throw new Error('Could not read earlier wallet payments');
  return parsed;
}

function writePersisted(ownerId: string, records: PersistedWalletPayment[]): void {
  storeWalletPayments(ownerId, YAPPR_CONTRACT_ID, STORAGE_KEY, JSON.stringify(records));
}

/**
 * Clear only the completed payment, leaving other scanned requests available
 * for reconciliation. Confirmations of the same payment under way elsewhere
 * are settled by it first.
 */
export async function clearPersistedWalletPayment(ownerId: string, reservationId: string): Promise<void> {
  return withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, async () => {
    const records = readPersisted(ownerId);
    const completed = records.find(record => record.reservationId === reservationId);
    if (!completed) return;
    settleAttempts(ownerId, completed);
    writePersisted(ownerId, records.filter(record => record.reservationId !== reservationId));
  });
}

/**
 * Under the write lock, before a local payment that replaces the requests
 * `reservationIds` is signed and once its answer is known: what it did, for
 * the tabs still showing their QR codes.
 */
export function markReplacedWalletPayments(ownerId: string, reservationIds: readonly string[], state: ReplacementState): void {
  if (reservationIds.length === 0) return;
  const ids = new Set(reservationIds);
  const at = Date.now();
  const records = readPersisted(ownerId);
  // A paid replacement settles the confirmations of the same payment still under way, as a paid QR does.
  if (state === 'completed') records.filter(record => ids.has(record.reservationId)).forEach(record => settleAttempts(ownerId, record));
  writePersisted(ownerId, records.map(record => (ids.has(record.reservationId) ? { ...record, replacedBy: { state, at } } : record)));
}

const replacementOf = (record: PersistedWalletPayment) =>
  (record.replacedBy && Date.now() - record.replacedBy.at < ATTEMPT_LIFETIME_MS ? record.replacedBy.state : undefined);

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
          const ceiling = detail.totalAgreedPrice;
          // purchaseCost is the actual charge, while totalAgreedPrice is only a ceiling.
          matches = document => BigInt(String(document.tokenAmount)) === amount
            && document.purchaseCost !== undefined && document.purchaseCost !== null
            && BigInt(String(document.purchaseCost)) <= ceiling;
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
    receiptId: receipt.id,
    request,
    data,
    checkOutcome: () => observe().then(observed => observed.outcome, (error: unknown) => {
      logger.debug('Could not read the wallet payment nonce:', error);
      return 'unknown' as const;
    }),
    observe,
  };

  async function observe(): Promise<PaymentObservation> {
    // A failed liveness read rejects: nothing is known, and the caller keeps the request.
    const { executable, consumedAt } = await request.checkLiveness();
    if (executable || consumedAt === undefined) return { outcome: 'unknown', executable };
    try {
      const sdk = await getEvoSdk();
      const response = await sdk.documents.getWithProof(TOKEN_HISTORY_CONTRACT_ID, receipt.type, receipt.id);
      const height = response.metadata?.height;
      if (!response.proof || typeof height !== 'bigint' || height <= BigInt(0)) return { outcome: 'unknown', executable };
      // A different receipt at this consumed nonce proves our request can never execute.
      if (response.data) return { outcome: receipt.matches(response.data.toObject()) ? 'completed' : 'absent', executable };
      return { outcome: height >= consumedAt ? 'absent' : 'unknown', executable };
    } catch (error) {
      logger.debug('Could not prove the wallet payment receipt:', error);
      return { outcome: 'unknown', executable };
    }
  }
}

function restorePayment(ownerId: string, record: PersistedWalletPayment): WalletPayment {
  const request = restoreWalletTransitionRequest(ownerId, base64ToBytes(record.bytes), BigInt(record.nonce), record.reservationId);
  return paymentFor(ownerId, request, record.data, record.key);
}

function reconcilePayment(payment: WalletPayment): Promise<PaymentObservation> {
  return payment.observe();
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
  /** Same-payment requests proved absent that a local payment at a fresh nonce would replace. */
  const replaceable: string[] = [];
  /** Hands `replaceable` to a local payment going ahead at a fresh nonce; any other outcome replaces nothing, so they go. */
  const settle = (result: LocalPreparedPayment): LocalPreparedPayment => {
    if (replaceable.length === 0 || !context) return result;
    if (!result.completed && !result.payment && !result.unresolved) return { ...result, replaces: [...replaceable] };
    const gone = new Set(replaceable);
    writePersisted(context.ownerId, readPersisted(context.ownerId).filter(item => !gone.has(item.reservationId)));
    return result;
  };
  const prepare = async (): Promise<LocalPreparedPayment> => {
    let candidate = cached;
    let cachedAbsent = false;
    let reconciliation: Awaited<ReturnType<typeof reconcilePayment>> | undefined;
    if (context) {
      // Under the lock, before anything else: another tab may have completed this very payment while the signer was asked for.
      const attempt = attemptSettled(context);
      if (attempt === 'settled') return { completed: true };
      if (attempt === 'gone') return { completed: false, unresolved: true };
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
      const drop = (record: PersistedWalletPayment) =>
        writePersisted(context.ownerId, readPersisted(context.ownerId).filter(item => item.reservationId !== record.reservationId));
      /** What this confirmation may take as its own completion: not one the user chose to send past. */
      const attributable = (record: PersistedWalletPayment, payment: WalletPayment, excluded: boolean) => !excluded && record.key === context.key
        && (!cached || cached.key !== context.key || cached.request.reservationId === record.reservationId
          || (cachedAbsent && payment.request.nonce > cached.request.nonce));
      for (const record of records) {
        const payment = restorePayment(context.ownerId, record);
        let result: PaymentObservation;
        // Only a request proved absent is ever marked replaced, and that proof is final.
        if (record.replacedBy) result = { outcome: 'absent', executable: false };
        else {
          try { result = await reconcilePayment(payment); }
          catch (error) {
            logger.debug('Could not reconcile the earlier wallet payment:', error);
            result = { outcome: 'unknown', executable: false };
          }
        }
        const excluded = context.allowAnother?.has(record.reservationId) === true;
        const replacement = replacementOf(record);
        if (replacement === 'completed') {
          // Paid by the local payment that replaced it: settles every tab still showing this request, never a new payment.
          if (excluded || record.key !== context.key || cached?.request.reservationId !== record.reservationId) continue;
          return settle({ completed: true });
        }
        if (replacement === 'sending') {
          // The local payment that replaced it may have gone through.
          if (excluded) continue;
          return settle({ completed: false, payment, unresolved: true, ...(record.key !== context.key ? { different: true } : {}) });
        }
        if (result.outcome === 'completed' || result.outcome === 'absent') {
          if (result.outcome === 'completed') settleAttempts(context.ownerId, record);
          // A local payment of this one goes ahead at a fresh nonce: the request stays, to be marked replaced by it.
          if (result.outcome === 'absent' && (!record.replacedBy || replacement === 'failed') && !build && !excluded && record.key === context.key) {
            replaceable.push(record.reservationId);
            continue;
          }
          drop(record);
          if (result.outcome === 'completed' && attributable(record, payment, excluded)) return settle({ completed: true });
          continue;
        }
        if (excluded) continue;
        if (record.key !== context.key) return settle({ completed: false, payment, unresolved: true, different: true });
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
    if (!candidate) return settle(await create());
    try {
      const result = reconciliation ?? await reconcilePayment(candidate);
      if (result.outcome === 'completed') return settle({ completed: true });
      if (result.outcome === 'absent') return settle(await create());
      if (context?.expose && (!context.isCurrent || context.isCurrent()) && result.executable) context.expose(candidate);
      return settle({ completed: false, payment: candidate, ...(!result.executable ? { unresolved: true } : {}) });
    } catch (error) {
      logger.debug('Could not reconcile the wallet payment; keeping its request:', error);
      return settle({ completed: false, payment: candidate, unresolved: true });
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
