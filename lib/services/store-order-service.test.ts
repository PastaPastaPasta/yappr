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
