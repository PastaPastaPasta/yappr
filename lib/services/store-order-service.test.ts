import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.unstubAllEnvs();
  });
});
