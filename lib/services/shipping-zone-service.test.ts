import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, updateDocument } = vi.hoisted(() => ({ get: vi.fn(), updateDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }));
import { SHIPPING_CHECK_FAILED_MESSAGE, SHIPPING_UNAVAILABLE_MESSAGE, checkShipping, finalShippingCheck, shippingProblem, shippingZoneService } from './shipping-zone-service';
import type { ShippingAddress, ShippingLine, ShippingZone } from '../../types';

const storeId = '11111111111111111111111111111111';
const tiers = { weightRate: 100, weightUnit: 'kg', subtotalMultipliers: [{ upTo: null, percent: 100 }] };
const raw = {
  $id: 'zone', $ownerId: 'owner', $revision: 2, $createdAt: 1700000000000,
  storeId, name: 'Domestic', rateType: 'weight_tiered', currency: 'USD',
  postalPatterns: '["^9\\\\d{4}$"]', tiers: JSON.stringify(tiers),
};

beforeEach(() => {
  shippingZoneService.clearCache();
  get.mockReset().mockResolvedValue(raw);
  updateDocument.mockReset().mockImplementation(async (_contract, _type, id, owner, data, revision) => ({
    success: true,
    document: { $id: id, $ownerId: owner, $revision: revision + 1, ...data },
  }));
});

describe('zone replacements (docs/archive/SOCIAL_V9.md TODO 20)', () => {
  it('a zone edit that does not name postalPatterns or tiers re-sends both as JSON strings', async () => {
    await shippingZoneService.updateZone('zone', 'owner', storeId, { name: 'Domestic (renamed)' });
    const replacement = updateDocument.mock.calls[0][4];
    expect(replacement).toMatchObject({ name: 'Domestic (renamed)', postalPatterns: raw.postalPatterns, tiers: raw.tiers });
    expect(replacement.storeId).toBeInstanceOf(Uint8Array);
  });
});

describe('zone edits can clear optional fields (QA D-10)', () => {
  it('making a zone worldwide and free removes countryPattern, flatRate and tiers', async () => {
    get.mockResolvedValue({ ...raw, rateType: 'flat', countryPattern: 'GB', flatRate: 300 });
    await shippingZoneService.updateZone('zone', 'owner', storeId, {
      name: 'Worldwide', rateType: 'flat', currency: 'USD', priority: 0,
      countryPattern: undefined, flatRate: undefined, tiers: undefined,
    });
    const replacement = updateDocument.mock.calls[0][4];
    expect(replacement).not.toHaveProperty('countryPattern');
    expect(replacement).not.toHaveProperty('flatRate');
    expect(replacement).not.toHaveProperty('tiers');
    expect(replacement).toMatchObject({ name: 'Worldwide', postalPatterns: raw.postalPatterns });
  });
});

describe('per-item zones at checkout (storefront v9, docs/STOREFRONT_V9.md)', () => {
  const zone = (id: string, overrides: Partial<ShippingZone> = {}): ShippingZone => ({
    id, ownerId: 'owner', storeId, createdAt: new Date(0), name: id, rateType: 'flat', flatRate: 500, priority: 1, ...overrides,
  });
  // Domestic: $5 + $2/kg. Canada: flat $15. Worldwide: $3/kg, free over $100.
  const domestic = zone('domestic', { countryPattern: 'US', rateType: 'weight_tiered', flatRate: 500, tiers: { weightRate: 200, weightUnit: 'kg' } });
  const canada = zone('canada', { countryPattern: 'CA', flatRate: 1500, priority: 2 });
  const worldwide = zone('worldwide', { rateType: 'weight_tiered', flatRate: 0, priority: 3, tiers: { weightRate: 300, weightUnit: 'kg', subtotalMultipliers: [{ upTo: 10000, percent: 100 }, { upTo: null, percent: 0 }] } });
  const zones = [domestic, canada, worldwide];
  const address = (country: string): ShippingAddress => ({ name: 'Bo', street: '1 Main', city: 'Town', postalCode: '12345', country });
  const line = (itemId: string, overrides: Partial<ShippingLine> = {}): ShippingLine => ({ itemId, title: itemId, weight: 1000, subtotal: 4000, ...overrides });

  /** What checkout charged before v9: one zone for the whole cart, matched once. */
  const singleZoneCost = (lines: ShippingLine[], to: ShippingAddress) => {
    const matched = shippingZoneService.findMatchingZone(zones, to);
    return matched ? shippingZoneService.calculateRate(matched, {
      totalWeight: lines.reduce((sum, item) => sum + item.weight, 0),
      subtotal: lines.reduce((sum, item) => sum + item.subtotal, 0),
    }) : null;
  };

  it('with no item naming zones, equals the one-zone price of the whole cart', () => {
    const lines = [line('a'), line('b', { weight: 2500, subtotal: 7000 }), line('c', { weight: 0, subtotal: 100 })];
    for (const country of ['US', 'CA', 'DE']) {
      const quote = shippingZoneService.quoteShipping(zones, lines, address(country));
      expect(quote.unshippable).toEqual([]);
      expect(quote.shipments).toHaveLength(1);
      expect(quote.cost).toBe(singleZoneCost(lines, address(country)));
    }
    // Worldwide is free over $100 for the cart as a whole.
    expect(shippingZoneService.quoteShipping(zones, lines, address('DE')).cost).toBe(0);
  });

  it('prices each zone\'s lines as their own shipment when no zone covers them all', () => {
    const lines = [line('domesticOnly', { zoneIds: ['domestic'], weight: 2000, subtotal: 3000 }), line('worldwideOnly', { zoneIds: ['worldwide'], weight: 1000, subtotal: 2000 })];
    const quote = shippingZoneService.quoteShipping(zones, lines, address('US'));
    expect(quote.shipments.map((shipment) => [shipment.zone.id, shipment.lines.map((carried) => carried.itemId), shipment.cost])).toEqual([
      ['domestic', ['domesticOnly'], 500 + 2 * 200],
      ['worldwide', ['worldwideOnly'], 300],
    ]);
    expect(quote.cost).toBe(900 + 300);
  });

  it('prefers one shipment: an unrestricted line joins the zone a limited line needs', () => {
    const local = zone('local', { countryPattern: 'US', flatRate: 500, priority: 1 });
    const northAmerica = zone('na', { countryPattern: 'US|CA|MX', flatRate: 1500, priority: 2 });
    const quote = shippingZoneService.quoteShipping([local, northAmerica], [line('mug'), line('belt', { zoneIds: ['na'] })], address('US'));
    expect(quote.shipments.map((shipment) => [shipment.zone.id, shipment.lines.map((carried) => carried.itemId)])).toEqual([['na', ['mug', 'belt']]]);
    expect(quote.cost).toBe(1500);
    // Alone, the mug still takes its own highest-priority zone.
    expect(shippingZoneService.quoteShipping([local, northAmerica], [line('mug')], address('US')).cost).toBe(500);
  });

  it('a line limited to zones that miss the address ships nowhere', () => {
    const quote = shippingZoneService.quoteShipping(zones, [line('a'), line('wallet', { title: 'Leather Wallet', zoneIds: ['domestic'] })], address('CA'));
    expect(quote.unshippable.map((unshipped) => unshipped.itemId)).toEqual(['wallet']);
    expect(quote.shipments.map((shipment) => shipment.zone.id)).toEqual(['canada']);
    expect(quote.cost).toBe(1500);
    expect(shippingProblem(quote, 'CA')).toBe("Leather Wallet doesn't ship to Canada. Remove it from your cart to continue.");
  });

  it('ignores ids that are not the store\'s zones, and an item whose zones are all gone ships nowhere', () => {
    const foreign = line('mixed', { zoneIds: ['someone-elses-zone', 'canada'] });
    const orphaned = line('orphan', { title: 'Old Belt', zoneIds: ['deleted-zone'] });
    const quote = shippingZoneService.quoteShipping(zones, [foreign, orphaned], address('CA'));
    expect(quote.shipments.map((shipment) => [shipment.zone.id, shipment.lines.map((carried) => carried.itemId)])).toEqual([['canada', ['mixed']]]);
    expect(quote.unshippable).toEqual([orphaned]);
    // Even worldwide-zone countries: the orphan names no zone the store still has.
    expect(shippingZoneService.quoteShipping(zones, [orphaned], address('DE')).unshippable).toEqual([orphaned]);
  });

  it('keeps the generic message when the store ships nothing there, and names several items', () => {
    const local = [zone('local', { countryPattern: 'US' })];
    const nowhere = shippingZoneService.quoteShipping(local, [line('a'), line('b')], address('CA'));
    expect(shippingProblem(nowhere, 'CA')).toBe(SHIPPING_UNAVAILABLE_MESSAGE);
    const named = shippingZoneService.quoteShipping(zones, [line('a', { title: 'Wallet', zoneIds: ['domestic'] }), line('b', { title: 'Belt', zoneIds: ['domestic'] }), line('c', { title: 'Wallet', zoneIds: ['domestic'] })], address('QQ'));
    expect(shippingProblem(named, 'QQ')).toBe("Wallet and Belt don't ship to QQ. Remove them from your cart to continue.");
    expect(shippingProblem(shippingZoneService.quoteShipping(zones, [line('a')], address('US')), 'US')).toBeNull();
    // An item that may use any zone and still misses: the store does not ship there, whatever else is limited.
    const mixed = shippingZoneService.quoteShipping(local, [line('a'), line('b', { title: 'Belt', zoneIds: ['local'] })], address('CA'));
    expect(shippingProblem(mixed, 'CA')).toBe(SHIPPING_UNAVAILABLE_MESSAGE);
  });

  describe('checkShipping: a store with no zones, or zones that could not be read', () => {
    const mug = line('mug', { title: 'Mug' });
    const wallet = line('wallet', { title: 'Leather Wallet', zoneIds: ['domestic'] });

    it('no zones: unrestricted lines check out free', () => {
      expect(checkShipping([], [mug], address('CA'))).toEqual({ quote: { shipments: [], unshippable: [], cost: 0 }, problem: null });
    });

    it('no zones: a line limited to zones ships nowhere, and is named', () => {
      const check = checkShipping([], [mug, wallet], address('CA'));
      expect(check.quote?.unshippable).toEqual([wallet]);
      expect(check.problem).toBe("Leather Wallet doesn't ship to Canada. Remove it from your cart to continue.");
    });

    it('zones unreadable: unrestricted lines check out free; a limited line waits for them', () => {
      expect(checkShipping(null, [mug], address('US'))).toEqual({ quote: null, problem: null });
      expect(checkShipping(null, [mug, wallet], address('US'))).toEqual({ quote: null, problem: SHIPPING_CHECK_FAILED_MESSAGE });
    });

    it('with zones: the quote and its problem', () => {
      const check = checkShipping(zones, [mug, wallet], address('CA'));
      expect(check.quote?.cost).toBe(1500);
      expect(check.problem).toBe("Leather Wallet doesn't ship to Canada. Remove it from your cart to continue.");
      expect(checkShipping(zones, [mug], address('US')).problem).toBeNull();
    });
  });

  describe('finalShippingCheck: shipping read again when the order is placed', () => {
    const format = (cost: number) => `$${(cost / 100).toFixed(2)}`;
    const quoted = (cost: number) => ({ quote: { shipments: [], unshippable: [], cost }, problem: null });

    it('the same cost proceeds', () => {
      expect(finalShippingCheck(1500, quoted(1500), format)).toEqual({ kind: 'proceed' });
      // A store with unreadable zones and only unrestricted lines ships free, as reviewed.
      expect(finalShippingCheck(0, { quote: null, problem: null }, format)).toEqual({ kind: 'proceed' });
    });

    it('a changed cost goes back to review, naming the new amount', () => {
      expect(finalShippingCheck(500, quoted(1500), format)).toEqual({ kind: 'review', message: 'Shipping changed to $15.00. Please review your order.' });
    });

    it('a line that no longer ships goes back to the shipping step', () => {
      const blocked = { quote: null, problem: "Leather Wallet doesn't ship to Canada. Remove it from your cart to continue." };
      expect(finalShippingCheck(500, blocked, format)).toEqual({ kind: 'back', message: blocked.problem });
    });

    it('shipping that could not be checked goes back too', () => {
      expect(finalShippingCheck(500, null, format)).toEqual({ kind: 'back', message: SHIPPING_CHECK_FAILED_MESSAGE });
      expect(finalShippingCheck(0, { quote: null, problem: SHIPPING_CHECK_FAILED_MESSAGE }, format)).toEqual({ kind: 'back', message: SHIPPING_CHECK_FAILED_MESSAGE });
    });
  });
});

describe('getByStore reads every zone of the store', () => {
  const zoneNo = (index: number) => ({
    id: `zone-${index}`, ownerId: 'owner', storeId, createdAt: new Date(0), name: `Zone ${index}`,
    rateType: 'flat' as const, flatRate: 100 + index, priority: index, countryPattern: index === 140 ? 'CA' : 'US',
  });
  const all = Array.from({ length: 150 }, (_, index) => zoneNo(index));

  it('walks the pages with startAfter, fresh each time, so a zone on page two resolves', async () => {
    const query = vi.spyOn(shippingZoneService, 'query').mockImplementation(async (options = {}) => {
      const from = options.startAfter ? all.findIndex((zone) => zone.id === options.startAfter) + 1 : 0;
      return { documents: all.slice(from, from + (options.limit ?? 100)) };
    });
    try {
      const zones = await shippingZoneService.getByStore(storeId);
      expect(zones).toHaveLength(150);
      expect(query.mock.calls.map(([options]) => [options?.startAfter, options?.limit])).toEqual([[undefined, 100], ['zone-99', 100]]);
      // An item limited to the zone on page two ships to Canada.
      const check = checkShipping(zones, [{ itemId: 'belt', title: 'Belt', zoneIds: ['zone-140'], weight: 0, subtotal: 100 }], { name: 'B', street: '1', city: 'C', postalCode: 'K1A', country: 'CA' });
      expect(check.problem).toBeNull();
      expect(check.quote?.shipments.map((shipment) => shipment.zone.id)).toEqual(['zone-140']);
      // No cache: the next read asks Platform again.
      await shippingZoneService.getByStore(storeId);
      expect(query).toHaveBeenCalledTimes(4);
    } finally {
      query.mockRestore();
    }
  });

  it('throws rather than answer with part of a list past 10 pages', async () => {
    let page = 0;
    const query = vi.spyOn(shippingZoneService, 'query').mockImplementation(async () => {
      page += 1;
      return { documents: Array.from({ length: 100 }, (_, index) => zoneNo(page * 100 + index)) };
    });
    try {
      await expect(shippingZoneService.getByStore(storeId)).rejects.toThrow('more than 1000 shipping zones');
      expect(query).toHaveBeenCalledTimes(10);
    } finally {
      query.mockRestore();
    }
  });
});
