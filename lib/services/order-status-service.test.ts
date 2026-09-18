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
const stranger = '22222222222222222222222222222222';
const buyer = '33333333333333333333333333333333';
const orderId = '44444444444444444444444444444444';

const update = (owner: string, status: string, createdAt: number) => ({
  $id: `${status}-${createdAt}`, $ownerId: owner, $createdAt: createdAt,
  orderId, sellerId: seller, buyerId: buyer, status,
});

beforeEach(() => query.mockReset());

describe('genuine status updates', () => {
  it('drops an update carrying the order ids but signed by someone other than the seller', async () => {
    // Consensus binds sellerId to the order but cannot bind $ownerId, so a
    // stranger's update lands; the newest GENUINE update must win.
    query.mockResolvedValueOnce([
      update(stranger, 'cancelled', 3000),
      update(seller, 'shipped', 2000),
      update(seller, 'processing', 1000),
    ]);
    const latest = await orderStatusService.getLatestStatus(orderId);
    expect(latest?.status).toBe('shipped');
    expect(latest?.ownerId).toBe(seller);
  });

  it('picks the newest genuine update per order from a batched read', () => {
    const latest = orderStatusService.latestPerOrder([
      orderStatusService.fromDocument(update(seller, 'processing', 1000)),
      orderStatusService.fromDocument(update(stranger, 'refunded', 5000)),
      orderStatusService.fromDocument(update(seller, 'delivered', 4000)),
    ]);
    expect(latest.get(orderId)?.status).toBe('delivered');
  });

  it('treats an update without an attested sellerId as not genuine on the v2 topology', () => {
    const legacy = orderStatusService.fromDocument({ $id: 'x', $ownerId: seller, $createdAt: 1, orderId, status: 'shipped' });
    expect(orderStatusService.isGenuine(legacy)).toBe(false);
  });

  it('keeps walking newest-first past a page of spoofs until the seller\'s update appears', async () => {
    const spoofs = Array.from({ length: 20 }, (_, i) => update(stranger, 'cancelled', 9000 - i));
    query.mockResolvedValueOnce(spoofs).mockResolvedValueOnce([update(seller, 'shipped', 100)]);
    const latest = await orderStatusService.getLatestStatus(orderId);
    expect(latest?.status).toBe('shipped');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatchObject({ startAfter: spoofs[19].$id });
  });
});
