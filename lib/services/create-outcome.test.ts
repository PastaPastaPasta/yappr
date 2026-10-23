import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateReceipt } from './state-transition-service';

const createDocument = vi.hoisted(() => vi.fn());
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({}) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument } }));

import { createOutcomeOf } from './create-outcome';
import { storeOrderService } from './store-order-service';

const BUYER = '33333333333333333333333333333333';
const SELLER = '11111111111111111111111111111111';
const receipt: CreateReceipt = { contractId: 'c', documentType: 'storeOrder', ownerId: BUYER, documentId: 'o1', nonce: BigInt(9), transition: new Uint8Array([1, 2, 3]) };
const sentDocument = { $id: 'o1', $ownerId: BUYER, $createdAt: 1000, storeId: SELLER, sellerId: SELLER, encryptedPayload: new Uint8Array(1), nonce: new Uint8Array(24) };
const orderData = { storeId: SELLER, sellerId: SELLER, encryptedPayload: new Uint8Array(1), nonce: new Uint8Array(24) };

beforeEach(() => {
  createDocument.mockReset();
});

describe('createOutcomeOf (WARCH-1)', () => {
  const read = (document: Record<string, unknown>) => document.$id;

  it('is confirmed only when the create says so (or says nothing, as before)', () => {
    expect(createOutcomeOf({ success: true, document: { $id: 'a' }, confirmed: true }, read)).toEqual({ status: 'confirmed', document: 'a' });
    expect(createOutcomeOf({ success: true, document: { $id: 'a' } }, read)).toEqual({ status: 'confirmed', document: 'a' });
  });

  it('keeps an unconfirmed create pending, with the receipt that settles it', () => {
    expect(createOutcomeOf({ success: true, document: { $id: 'a' }, confirmed: false, receipt }, read)).toEqual({ status: 'pending', document: 'a', receipt });
    expect(createOutcomeOf({ success: true, document: { $id: 'a' }, confirmed: false }, read)).toEqual({ status: 'pending', document: 'a' });
  });

  it('is failed on a refusal, with its error', () => {
    expect(createOutcomeOf({ success: false, error: 'refused' }, read)).toEqual({ status: 'failed', error: 'refused' });
    expect(createOutcomeOf({ success: false }, read)).toEqual({ status: 'failed', error: 'Failed to create document' });
  });
});

describe('BaseDocumentService.createOutcome', () => {
  it('returns the transformed document and the receipt of an unconfirmed create', async () => {
    createDocument.mockResolvedValue({ success: true, document: sentDocument, confirmed: false, receipt });
    const outcome = await storeOrderService.createOutcome(BUYER, orderData);
    expect(outcome.status).toBe('pending');
    if (outcome.status !== 'pending') return;
    expect(outcome.receipt).toBe(receipt);
    expect(outcome.document).toMatchObject({ id: 'o1', buyerId: BUYER, storeId: SELLER });
  });

  it('rejects on an unexpected throw rather than calling it failed (the create may have been sent)', async () => {
    createDocument.mockRejectedValue(new Error('lost'));
    await expect(storeOrderService.createOutcome(BUYER, orderData)).rejects.toThrow('lost');
  });

  it('leaves createWithOptions as it was: a document flagged __createConfirmed, a throw on failure', async () => {
    createDocument.mockResolvedValue({ success: true, document: sentDocument, confirmed: false, receipt });
    expect(await storeOrderService.create(BUYER, orderData)).toMatchObject({ id: 'o1', __createConfirmed: false });
    createDocument.mockResolvedValue({ success: true, document: sentDocument, confirmed: true });
    expect(await storeOrderService.create(BUYER, orderData)).toMatchObject({ __createConfirmed: true });
    createDocument.mockResolvedValue({ success: false, error: 'refused' });
    await expect(storeOrderService.create(BUYER, orderData)).rejects.toThrow('refused');
  });
});
