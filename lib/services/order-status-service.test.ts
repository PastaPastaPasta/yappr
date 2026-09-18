import { beforeEach, describe, expect, it, vi } from 'vitest';

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
