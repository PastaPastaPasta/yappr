import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The topology constant is read at module load, so the env must be set before
// the hoisted import evaluates.
const query = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STOREFRONT_TOPOLOGY = 'v2';
  return vi.fn();
});
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
import { orderStatusService } from './order-status-service';

const seller = '11111111111111111111111111111111';
const buyer = '33333333333333333333333333333333';
const orderId = '44444444444444444444444444444444';

// Every update is the order's seller: v2 gates the writer against the order's
// sellerId, so a stranger's update never reaches the client to be filtered.
const update = (status: string, createdAt: number) => ({
  $id: `${status}-${createdAt}`, $ownerId: seller, $createdAt: createdAt,
  orderId, buyerId: buyer, status,
});

beforeEach(() => query.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe('latest status', () => {
  it('reads the newest update in ONE row — the writer gate leaves nothing to skip past', async () => {
    query.mockResolvedValueOnce([update('shipped', 2000)]);
    const latest = await orderStatusService.getLatestStatus(orderId);
    expect(latest?.status).toBe('shipped');
    expect(latest?.ownerId).toBe(seller);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatchObject({ limit: 1 });
  });

  it('reports no status when an order has none', async () => {
    query.mockResolvedValueOnce([]);
    expect(await orderStatusService.getLatestStatus(orderId)).toBeNull();
  });

  it('picks the newest update per order from a batched read', () => {
    const latest = orderStatusService.latestPerOrder([
      orderStatusService.fromDocument(update('processing', 1000)),
      orderStatusService.fromDocument(update('delivered', 4000)),
      orderStatusService.fromDocument(update('shipped', 2000)),
    ]);
    expect(latest.get(orderId)?.status).toBe('delivered');
  });
});

describe('the buyer is derived on storefront v6', () => {
  const write = async (topology: string) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology);
    const { orderStatusService: service } = await import('./order-status-service');
    const create = vi.spyOn(service, 'create' as never).mockResolvedValue({} as never);
    await service.createStatusUpdate(seller, orderId, { status: 'shipped', buyerId: buyer });
    return (create.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
  };

  it('copies buyerId on v2–v5 and not on v6 (buyerFeed indexes orderId.$ownerId)', async () => {
    expect(await write('v5')).toHaveProperty('buyerId');
    expect(await write('v6')).not.toHaveProperty('buyerId');
    expect(await write('v1')).not.toHaveProperty('buyerId');
  });
});

describe('tracking and message by topology', () => {
  const note = { trackingCarrier: 'UPS', trackingNumber: '1Z999', message: 'On its way' };

  const load = async (topology: string) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology);
    const statusModule = await import('./order-status-service');
    const crypto = await import('../crypto/digital-delivery');
    const create = vi.spyOn(statusModule.orderStatusService, 'create' as never).mockResolvedValue({ id: 'created', orderId, status: 'shipped' } as never);
    const written = () => (create.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    return { ...statusModule, ...crypto, create, written };
  };

  it('writes plaintext fields below v10, exactly as before', async () => {
    const { orderStatusService: service, written } = await load('v9');
    await service.createStatusUpdate(seller, orderId, { status: 'shipped', buyerId: buyer, ...note, orderKey: new Uint8Array(32) });
    expect(written()).toMatchObject(note);
    expect(written()).not.toHaveProperty('encryptedPayload');
    expect(written()).not.toHaveProperty('nonce');
  });

  it('reads plaintext fields below v10 and ignores any sealed bytes', async () => {
    const { orderStatusService: service } = await load('v9');
    const read = service.fromDocument({ ...update('shipped', 1000), ...note });
    expect(read).toMatchObject(note);
    expect(read.sealedNote).toBeUndefined();
  });

  it('seals tracking, carrier and message on v10 and writes no plaintext', async () => {
    const { orderStatusService: service, written, decryptOrderStatusNote, decodeOrderStatusNote } = await load('v10');
    const orderKey = new Uint8Array(32).fill(7);
    const returned = await service.createStatusUpdate(seller, orderId, { status: 'shipped', buyerId: buyer, ...note, orderKey });
    const data = written();
    expect(data).not.toHaveProperty('trackingNumber');
    expect(data).not.toHaveProperty('trackingCarrier');
    expect(data).not.toHaveProperty('message');
    expect(data).not.toHaveProperty('buyerId');
    expect((data.nonce as Uint8Array).length).toBe(24);
    expect(decodeOrderStatusNote(decryptOrderStatusNote(data.encryptedPayload as Uint8Array, data.nonce as Uint8Array, orderKey, orderId))).toEqual(note);
    expect(returned).toMatchObject(note);
  });

  it('writes neither field on v10 when the status carries no note', async () => {
    const { orderStatusService: service, written } = await load('v10');
    await service.createStatusUpdate(seller, orderId, { status: 'processing', buyerId: buyer, trackingNumber: '', message: '' });
    expect(written()).not.toHaveProperty('encryptedPayload');
    expect(written()).not.toHaveProperty('nonce');
    expect(written()).not.toHaveProperty('message');
  });

  it('refuses a note on v10 without the order key, in words a seller can act on', async () => {
    const { orderStatusService: service, create } = await load('v10');
    await expect(service.createStatusUpdate(seller, orderId, { status: 'shipped', buyerId: buyer, message: 'Hi' }))
      .rejects.toThrow(/sent privately to the buyer.*Unlock private messaging/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a note past the contract cap before signing', async () => {
    const { orderStatusService: service, create } = await load('v10');
    const { STATUS_NOTE_MAX_BYTES } = await import('../storefront/storefront-contract');
    await expect(service.createStatusUpdate(seller, orderId, { status: 'shipped', buyerId: buyer, message: 'x'.repeat(STATUS_NOTE_MAX_BYTES), orderKey: new Uint8Array(32) }))
      .rejects.toThrow(/too long to send/);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the sealed bytes on read and leaves the plaintext fields empty on v10', async () => {
    const { orderStatusService: service } = await load('v10');
    const read = service.fromDocument({
      ...update('shipped', 1000),
      trackingNumber: 'plaintext-is-ignored',
      encryptedPayload: [1, 2, 3],
      nonce: new Uint8Array(24),
    });
    expect(read.sealedNote?.encryptedPayload).toEqual(new Uint8Array([1, 2, 3]));
    expect(read.sealedNote?.nonce).toHaveLength(24);
    expect(read.trackingNumber).toBeUndefined();
    expect(read.message).toBeUndefined();
    expect(service.fromDocument(update('shipped', 1000)).sealedNote).toBeUndefined();
  });

  it('opens a sealed note with the order key, and never throws on one it cannot open', async () => {
    const { orderStatusService: service, openStatusNote, encryptOrderStatusNote, encodeOrderStatusNote } = await load('v10');
    const key = new Uint8Array(32).fill(3);
    const sealed = encryptOrderStatusNote(encodeOrderStatusNote(note), key, orderId);
    const read = service.fromDocument({ ...update('shipped', 1000), ...sealed });
    expect(openStatusNote(read, key)).toMatchObject(note);
    expect(openStatusNote(read, new Uint8Array(32).fill(4))).toBe(read);
    expect(openStatusNote({ ...read, orderId: 'another-order' }, key).message).toBeUndefined();
    const plain = service.fromDocument(update('processing', 1000));
    expect(openStatusNote(plain, key)).toBe(plain);
  });

  it('opens a map of updates for the seller and the buyer through the order, and leaves what it cannot open sealed', async () => {
    const { orderStatusService: service, openStatusNotesAsSeller, openStatusNotesAsBuyer, encryptOrderStatusNote, encodeOrderStatusNote, sellerOrderDeliveryKey } = await load('v10');
    const { getPublicKey } = await import('../crypto/keys');
    const { privateFeedCryptoService } = await import('./private-feed-crypto-service');
    const buyerKey = new Uint8Array(32).fill(5);
    const sellerKey = new Uint8Array(32).fill(6);
    const nonce = new Uint8Array(24).fill(9);
    const storeId = 'store-1';
    const ephemeral = privateFeedCryptoService.deriveOrderEphemeralKey(buyerKey, nonce, storeId);
    const encryptedPayload = await privateFeedCryptoService.eciesEncryptWithEphemeralKey(ephemeral, getPublicKey(sellerKey), new TextEncoder().encode('{}'), new TextEncoder().encode('yappr/order/v1'));
    const order = { id: orderId, storeId, sellerId: seller, nonce, encryptedPayload };

    const sealed = encryptOrderStatusNote(encodeOrderStatusNote(note), sellerOrderDeliveryKey(order, sellerKey), orderId);
    const updates = new Map([[orderId, service.fromDocument({ ...update('shipped', 1000), ...sealed })]]);

    expect(openStatusNotesAsSeller(updates, [order], sellerKey).get(orderId)).toMatchObject(note);
    expect(openStatusNotesAsBuyer(updates, [order], buyerKey, new Map([[seller, getPublicKey(sellerKey)]])).get(orderId)).toMatchObject(note);
    // No seller key known, wrong key, or no matching order: stays sealed, no error.
    expect(openStatusNotesAsBuyer(updates, [order], buyerKey, new Map()).get(orderId)?.message).toBeUndefined();
    expect(openStatusNotesAsBuyer(updates, [order], new Uint8Array(32).fill(1), new Map([[seller, getPublicKey(sellerKey)]])).get(orderId)?.message).toBeUndefined();
    expect(openStatusNotesAsSeller(updates, [], sellerKey).get(orderId)?.message).toBeUndefined();
  });
});
