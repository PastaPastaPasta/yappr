import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
import { storeOrderService } from './store-order-service';

const seller = '11111111111111111111111111111111';
const order = (index: number) => ({
  $id: `order-${index}`, $ownerId: '33333333333333333333333333333333', $createdAt: 1000 + index,
  storeId: seller, sellerId: seller, encryptedPayload: new Uint8Array(), nonce: new Uint8Array(),
});

beforeEach(() => query.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe('seller orders (QA D-23)', () => {
  it('pages newest first and hands back a cursor for the next page', async () => {
    query.mockResolvedValueOnce([order(2), order(1)]);
    const { orders, nextCursor } = await storeOrderService.getSellerOrders(seller, { limit: 2, startAfter: 'order-3' });
    expect(query.mock.calls[0][0]).toMatchObject({
      where: [['sellerId', '==', seller]],
      orderBy: [['sellerId', 'asc'], ['$createdAt', 'desc']],
      limit: 2,
      startAfter: 'order-3',
    });
    expect(orders.map((o) => o.id)).toEqual(['order-2', 'order-1']);
    expect(nextCursor).toBe('order-1');
  });
});

describe('orders copy the store status on storefront v5 (QA D-25)', () => {
  const place = async (topology: string) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology);
    const { storeOrderService: service } = await import('./store-order-service');
    const create = vi.spyOn(service, 'create' as never).mockResolvedValue({} as never);
    await service.createOrder('33333333333333333333333333333333', { storeId: seller, sellerId: seller, encryptedPayload: new Uint8Array(1), nonce: new Uint8Array(24) });
    return (create.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
  };

  it('writes storeStatus active on v5, and nothing new before it', async () => {
    expect((await place('v5')).storeStatus).toBe('active');
    expect(await place('v4')).not.toHaveProperty('storeStatus');
  });
});

describe('storefront v6 (the mainnet re-cut)', () => {
  const loadV6 = async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', 'v6');
    const [{ storeOrderService: service }, { storeService }] = await Promise.all([import('./store-order-service'), import('./store-service')]);
    return { service, storeService };
  };

  it("pages a seller's orders on their store (storeOrders), the store pinned with ==", async () => {
    const { service, storeService } = await loadV6();
    vi.spyOn(storeService, 'getByOwner').mockResolvedValue({ id: 'store-1' } as never);
    query.mockResolvedValueOnce([order(2)]);
    await service.getSellerOrders(seller, { limit: 1, startAfter: 'order-3' });
    expect(query.mock.calls[0][0]).toMatchObject({
      where: [['storeId', '==', 'store-1']],
      orderBy: [['storeId', 'asc'], ['$createdAt', 'desc']],
      startAfter: 'order-3',
    });
  });

  it('a seller without a store has no orders (and makes no order query)', async () => {
    const { service, storeService } = await loadV6();
    vi.spyOn(storeService, 'getByOwner').mockResolvedValue(null);
    expect(await service.getSellerOrders(seller)).toEqual({ orders: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses an order from your own store before signing', async () => {
    const create = vi.spyOn(storeOrderService, 'create' as never).mockResolvedValue({} as never);
    await expect(storeOrderService.createOrder(seller, { storeId: seller, sellerId: seller, encryptedPayload: new Uint8Array(1), nonce: new Uint8Array(24) }))
      .rejects.toThrow(/your own store/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an encrypted payload past the 5,120 B cap before signing on v6', async () => {
    const { service } = await loadV6();
    const create = vi.spyOn(service, 'create' as never).mockResolvedValue({} as never);
    const place = (bytes: number) => service.createOrder('33333333333333333333333333333333', { storeId: seller, sellerId: seller, encryptedPayload: new Uint8Array(bytes), nonce: new Uint8Array(24) });
    await expect(place(5121)).rejects.toThrow(/too large to send/);
    expect(create).not.toHaveBeenCalled();
    await place(5120);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('the encrypted order size the checkout budget assumes', () => {
  it('is the payload JSON plus ORDER_CIPHERTEXT_OVERHEAD (ephemeral key + Poly1305 tag)', async () => {
    const [{ getPublicKey }, { ORDER_CIPHERTEXT_OVERHEAD }] = await Promise.all([import('@/lib/crypto/keys'), import('@/lib/storefront/storefront-contract')]);
    const key = (byte: number) => new Uint8Array(32).fill(byte);
    const payload = storeOrderService.buildOrderPayload([], undefined, { email: 'ann@example.com' }, 0, 'dash:X', 'USD', 'leave at the door – thanks');
    const encrypted = await storeOrderService.encryptOrderPayload(payload, key(1), getPublicKey(key(2)), new Uint8Array(24), seller);
    expect(encrypted.length).toBe(new TextEncoder().encode(JSON.stringify(payload)).length + ORDER_CIPHERTEXT_OVERHEAD);
  });
});
