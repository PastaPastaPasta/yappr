import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: {} }));
import { orderDeliveryService } from './order-delivery-service';

const buyer = '33333333333333333333333333333333';
const [order1, order2] = ['11111111111111111111111111111111', '44444444444444444444444444444444'];
const delivery = (index: number, orderId = order1) => ({
  $id: `delivery-${index}`, $ownerId: 'seller', $createdAt: 1000 + index,
  orderId, encryptedPayload: new Uint8Array(4), nonce: new Uint8Array(24),
});

beforeEach(() => query.mockReset());

describe("the buyer's library (buyerDeliveries [orderId.$ownerId, $createdAt])", () => {
  it('pins the derived order owner with == on every page of the cursor walk', async () => {
    query
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => delivery(i, i < 50 ? order1 : order2)))
      .mockResolvedValueOnce([delivery(100, order2)]);
    const byOrder = await orderDeliveryService.getForBuyer(buyer);
    expect(query).toHaveBeenCalledTimes(2);
    for (const [options] of query.mock.calls) {
      expect(options).toMatchObject({ where: [['orderId.$ownerId', '==', buyer]], orderBy: [['orderId.$ownerId', 'asc'], ['$createdAt', 'asc']] });
    }
    expect(query.mock.calls[1][0].startAfter).toBe('delivery-99');
    expect(byOrder.get(order1)).toHaveLength(50);
    expect(byOrder.get(order2)).toHaveLength(51);
  });

  it('publishes no buyer id: the index reads the order', async () => {
    const create = vi.spyOn(orderDeliveryService, 'create' as never).mockResolvedValue({} as never);
    await orderDeliveryService.publish('seller', { id: buyer }, { encryptedPayload: new Uint8Array(4), nonce: new Uint8Array(24) }, { v: 1, items: [] });
    const data = (create.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(Object.keys(data).sort()).toEqual(['encryptedPayload', 'nonce', 'orderId']);
  });
});
