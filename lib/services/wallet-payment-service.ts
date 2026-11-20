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

type PersistedWalletPayment = {
  key: string;
  bytes: string;
  nonce: string;
  reservationId: string;
  data: PaymentData;
};
type PaymentContext = {
  ownerId: string;
  key: string;
  /** The user chose, in this confirmation, to pay again although an earlier request may have gone through. */
  payAgain?: boolean;
  expose?: (payment: WalletPayment) => void;
  isCurrent?: () => boolean;
};

/** What the user is told when an earlier request of the same payment may have gone through and can't be checked. */
export const MAY_HAVE_PAID_MESSAGE = "This payment may already have gone through. Check your wallet's history.";

/**
 * Where a payment stands. `completed`: a request of it is proved paid (the
 * caller clears that request once it shows the result). `unproven`: a request
 * of it may have gone through and can't be checked, so nothing is paid again
 * until the user confirms. `unresolved`: its request couldn't be checked just
 * now. Otherwise `payment` is the request to show or sign at its own nonce,
 * or none: nothing of this payment is outstanding.
 */
export type LocalPreparedPayment =
  | { completed: true; unproven?: undefined; payment?: WalletPayment }
  | { completed: false; unproven: true; payment?: undefined }
  | { completed: false; unproven?: undefined; payment?: WalletPayment; unresolved?: true };
export type LocalWalletPaymentIntent = {
  key: string;
  cached?: WalletPayment;
  payAgain?: boolean;
  onPrepared?: (prepared: LocalPreparedPayment) => void;
};
type PreparedPayment =
  | { completed: true; unproven?: undefined; payment?: WalletPayment }
  | { completed: false; unproven: true; payment?: undefined }
  | { completed: false; unproven?: undefined; payment: WalletPayment; unresolved?: true };
const STORAGE_KEY = scopedKey('wallet-payments:v1');

/** A stored request that names its payment, reservation and nonce: anything less can't be judged at all. */
const readable = (record: unknown): record is PersistedWalletPayment => {
  const item = record as Partial<PersistedWalletPayment> | null;
  return typeof item?.key === 'string' && typeof item.reservationId === 'string' && typeof item.nonce === 'string' && /^\d+$/.test(item.nonce);
};

function readPersisted(ownerId: string): PersistedWalletPayment[] {
  const raw = loadWalletPayments(ownerId, YAPPR_CONTRACT_ID, STORAGE_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!Array.isArray(parsed)) throw new UnreadableJournalError(raw, []);
  if (!parsed.every(readable)) throw new UnreadableJournalError(raw, parsed.filter(readable));
  return parsed;
}

/** Stored requests that can't all be read: any payment may be among them. */
class UnreadableJournalError extends Error {
  constructor(readonly raw: string, readonly readable: PersistedWalletPayment[]) { super('Could not read earlier wallet payments'); }
}

function writePersisted(ownerId: string, records: PersistedWalletPayment[]): void {
  storeWalletPayments(ownerId, YAPPR_CONTRACT_ID, STORAGE_KEY, JSON.stringify(records));
}

/** Stored requests that could not be read, kept aside once a confirmation chose to pay again past them; every other confirmation still sees them. */
const SET_ASIDE_KEY = `${STORAGE_KEY}:unreadable`;

function setAsideUnreadable(ownerId: string, raw: string): void {
  const previous = loadWalletPayments(ownerId, YAPPR_CONTRACT_ID, SET_ASIDE_KEY);
  let blobs: unknown;
  try { blobs = previous === null ? [] : JSON.parse(previous); } catch { blobs = [previous]; }
  storeWalletPayments(ownerId, YAPPR_CONTRACT_ID, SET_ASIDE_KEY, JSON.stringify([...(Array.isArray(blobs) ? blobs : [previous]), raw]));
}

/** Clear a request once the confirmation that proved it paid has shown that to the user. */
export async function clearPersistedWalletPayment(ownerId: string, reservationId: string): Promise<void> {
  return withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, async () => {
    const records = readPersisted(ownerId);
    if (!records.some(record => record.reservationId === reservationId)) return;
    writePersisted(ownerId, records.filter(record => record.reservationId !== reservationId));
  });
}

function persistPayment(payment: WalletPayment, ownerId: string): void {
  const records = readPersisted(ownerId).filter(record => record.reservationId !== payment.request.reservationId);
  records.push({ key: payment.key, bytes: bytesToBase64(payment.request.bytes), nonce: payment.request.nonce.toString(),
    reservationId: payment.request.reservationId, data: payment.data });
  writePersisted(ownerId, records);
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

export async function prepareWalletPayment(
  cached: WalletPayment | undefined,
  build: (lockHeld?: boolean) => Promise<WalletPayment>,
  context: PaymentContext
): Promise<PreparedPayment> {
  const result = await preparePayment(cached, build, context);
  if (result.completed || result.unproven) return result;
  if (!result.payment) throw new Error('No wallet payment was built');
  return { ...result, payment: result.payment };
}

export function prepareLocalWalletPayment(cached: WalletPayment | undefined, context: PaymentContext, lockHeld = false) {
  return preparePayment(cached, undefined, context, lockHeld);
}

/** The latest stored request of the payment `key`, if one can be read: what a local confirmation that showed no QR binds to. */
export function findShownWalletPayment(ownerId: string, key: string): Promise<WalletPayment | undefined> {
  return withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, async () => {
    let records: PersistedWalletPayment[];
    try { records = readPersisted(ownerId); }
    catch (error) {
      if (error instanceof UnreadableJournalError) return undefined;
      throw error;
    }
    const latest = records.filter(record => record.key === key).sort((a, b) => (BigInt(a.nonce) < BigInt(b.nonce) ? 1 : -1))[0];
    if (!latest) return undefined;
    await getEvoSdk();
    try { return restorePayment(ownerId, latest); }
    catch (error) {
      logger.debug('Could not read the stored wallet payment request:', error);
      return undefined;
    }
  });
}

/**
 * Under the write lock: where the payment `context.key` stands, from the
 * request this confirmation showed (`cached`) and the stored requests of the
 * same payment. A request is cleared here only once proved unpaid; one proved
 * paid is cleared by the caller once it has shown that. While a request can
 * still execute it is shown again (or signed at its own nonce), never a new
 * one beside it, and while one's outcome can't be proved just now nothing new
 * is built. When a request can't be read at all, or the request this
 * confirmation showed was proved unpaid with nothing of the same payment
 * stored after it, nothing new is built or sent until the user chooses, in
 * this confirmation, to pay again (`payAgain`).
 */
async function preparePayment(
  cached: WalletPayment | undefined,
  build: ((lockHeld?: boolean) => Promise<WalletPayment>) | undefined,
  context: PaymentContext,
  lockHeld = false
): Promise<LocalPreparedPayment> {
  const { ownerId, key, payAgain } = context;
  const mayHavePaid = { completed: false, unproven: true } as const;
  const prepare = async (): Promise<LocalPreparedPayment> => {
    let records: PersistedWalletPayment[];
    try { records = readPersisted(ownerId); }
    catch (error) {
      if (!(error instanceof UnreadableJournalError)) throw error;
      if (!payAgain) return mayHavePaid;
      // Only what can't be read is set aside, kept under a key of its own; every readable request stays.
      logger.warn('Setting aside unreadable wallet payment requests after the user chose to pay again');
      setAsideUnreadable(ownerId, error.raw);
      writePersisted(ownerId, error.readable);
      records = error.readable;
    }
    if (!payAgain && loadWalletPayments(ownerId, YAPPR_CONTRACT_ID, SET_ASIDE_KEY) !== null) return mayHavePaid;
    const mine = records.filter(record => record.key === key);
    /** A request of this payment that can't be read: whether it went through can never be told. */
    let unreadable = false;
    /** A request of this payment that can no longer execute, whose outcome couldn't be proved just now. */
    let unchecked: WalletPayment | undefined;
    let shownUnpaid = false;
    let candidate: WalletPayment | undefined;
    if (cached && !mine.some(record => record.reservationId === cached.request.reservationId)) {
      let observed: PaymentObservation;
      try { observed = await cached.observe(); }
      catch (error) {
        logger.debug('Could not check the wallet payment request shown:', error);
        return { completed: false, payment: cached, unresolved: true };
      }
      if (observed.outcome === 'completed') return { completed: true, payment: cached };
      if (observed.executable) {
        persistPayment(cached, ownerId);
        candidate = cached;
      } else if (observed.outcome === 'absent') shownUnpaid = true;
      else unchecked = cached;
    }
    // The WASM module restoring them must be up, so a request is judged unreadable only for what it holds.
    if (mine.length > 0) await getEvoSdk();
    for (const record of mine) {
      let payment: WalletPayment;
      try { payment = record.reservationId === cached?.request.reservationId ? cached : restorePayment(ownerId, record); }
      catch (error) {
        logger.warn('Could not read an earlier wallet payment request:', error);
        unreadable = true;
        continue;
      }
      let observed: PaymentObservation;
      try { observed = await payment.observe(); }
      catch (error) {
        logger.debug('Could not check an earlier wallet payment request:', error);
        return { completed: false, payment, unresolved: true };
      }
      if (observed.outcome === 'completed') return { completed: true, payment };
      if (observed.outcome === 'absent') {
        writePersisted(ownerId, readPersisted(ownerId).filter(item => item.reservationId !== record.reservationId));
        continue;
      }
      if (!observed.executable) {
        unchecked ??= payment;
        continue;
      }
      if (!candidate || payment === cached) candidate = payment;
    }
    if (unchecked) return { completed: false, payment: unchecked, unresolved: true };
    if (unreadable && !payAgain) return mayHavePaid;
    if (candidate) {
      if (context.expose && (!context.isCurrent || context.isCurrent())) context.expose(candidate);
      return { completed: false, payment: candidate };
    }
    if (shownUnpaid && !payAgain) return mayHavePaid;
    if (!build) return { completed: false };
    const payment = { ...(await build(true)), key };
    if (context.isCurrent && !context.isCurrent()) {
      await payment.request.discard(true);
      return { completed: false, payment };
    }
    try { persistPayment(payment, ownerId); }
    catch (error) { await payment.request.discard(true); throw error; }
    context.expose?.(payment);
    return { completed: false, payment };
  };
  return lockHeld ? prepare() : withIdentityWriteLock(ownerId, YAPPR_CONTRACT_ID, prepare);
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
