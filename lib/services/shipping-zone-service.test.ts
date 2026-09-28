import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, updateDocument } = vi.hoisted(() => ({ get: vi.fn(), updateDocument: vi.fn() }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { get } }) }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { updateDocument } }));
import { shippingZoneService } from './shipping-zone-service';

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

describe('zone replacements (docs/SOCIAL_V9.md TODO 20)', () => {
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
