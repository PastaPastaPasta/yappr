import { logger } from '@/lib/logger';
/**
 * Shipping Zone Service
 *
 * Manages shipping zones and rate calculation.
 * Supports flat, weight-tiered, and price-tiered rates.
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { identifierToBase58, identifierStringToDocumentBytes } from './sdk-helpers';
import type {
  ShippingZone,
  ShippingZoneDocument,
  ShippingRateType,
  ShippingTier,
  ShippingPricingConfig,
  SubtotalMultiplier,
  ShippingAddress,
  ShippingLine,
  ShippingQuote,
  Shipment
} from '../../types';
import { gramsToUnit } from '../utils/weight';

class ShippingZoneService extends BaseDocumentService<ShippingZone> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.SHIPPING_ZONE, YAPPR_STOREFRONT_CONTRACT_ID);
  }

  /**
   * `update()` rebuilds the full replace from the TRANSFORMED zone, where
   * `postalPatterns` is an array, `tiers` an object and `storeId` base58. Both
   * JSON fields are strings on every storefront cut, so re-encode them, or a
   * zone edit that does not name them re-sends values no cut accepts.
   */
  protected extractContentFields(doc: ShippingZone): Record<string, unknown> {
    const fields = super.extractContentFields(doc);
    if (typeof fields.storeId === 'string') fields.storeId = fields.storeId ? identifierStringToDocumentBytes(fields.storeId) : undefined;
    for (const key of ['postalPatterns', 'tiers'] as const) {
      if (fields[key] && typeof fields[key] === 'object') fields[key] = JSON.stringify(fields[key]);
    }
    return fields;
  }

  protected transformDocument(doc: Record<string, unknown>): ShippingZone {
    const data = (doc.data || doc) as ShippingZoneDocument;

    // Convert storeId from byte array to base58
    const storeId = identifierToBase58(data.storeId) || '';

    // Parse JSON fields - handle both string (from SDK query) and object (from state transition)
    let postalPatterns: string[] | undefined;
    if (data.postalPatterns) {
      if (Array.isArray(data.postalPatterns)) {
        postalPatterns = data.postalPatterns;
      } else if (typeof data.postalPatterns === 'string') {
        try {
          postalPatterns = JSON.parse(data.postalPatterns);
        } catch {
          logger.error('Failed to parse postalPatterns:', data.postalPatterns);
        }
      }
    }

    // Parse tiers - can be legacy array format or new object format
    let tiers: ShippingTier[] | ShippingPricingConfig | undefined;
    if (data.tiers) {
      if (typeof data.tiers === 'object') {
        // Already parsed (from state transition result)
        tiers = data.tiers as ShippingTier[] | ShippingPricingConfig;
      } else if (typeof data.tiers === 'string') {
        try {
          tiers = JSON.parse(data.tiers);
        } catch {
          logger.error('Failed to parse tiers:', data.tiers);
        }
      }
    }

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      storeId,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      $revision: doc.$revision as number | undefined,
      name: data.name,
      postalPatterns,
      countryPattern: data.countryPattern,
      rateType: data.rateType,
      flatRate: data.flatRate,
      tiers,
      currency: data.currency,
      priority: data.priority || 0
    };
  }

  /**
   * Get zones for a store
   */
  async getByStore(storeId: string): Promise<ShippingZone[]> {
    const { documents } = await this.query({
      where: [['storeId', '==', storeId]],
      orderBy: [['storeId', 'asc'], ['priority', 'asc']],
      limit: 100
    });

    return documents;
  }

  /**
   * Create a new shipping zone
   */
  async createZone(
    ownerId: string,
    storeId: string,
    data: {
      name: string;
      postalPatterns?: string[];
      countryPattern?: string;
      rateType: ShippingRateType;
      flatRate?: number;
      tiers?: ShippingTier[] | ShippingPricingConfig;
      currency?: string;
      priority?: number;
    }
  ): Promise<ShippingZone> {
    const documentData: Record<string, unknown> = {
      storeId: identifierStringToDocumentBytes(storeId),
      name: data.name,
      rateType: data.rateType
    };

    if (data.postalPatterns) documentData.postalPatterns = JSON.stringify(data.postalPatterns);
    if (data.countryPattern) documentData.countryPattern = data.countryPattern;
    if (data.flatRate !== undefined) documentData.flatRate = data.flatRate;
    if (data.tiers) documentData.tiers = JSON.stringify(data.tiers);
    if (data.currency) documentData.currency = data.currency;
    if (data.priority !== undefined) documentData.priority = data.priority;

    return this.create(ownerId, documentData);
  }

  /**
   * Update a shipping zone
   */
  async updateZone(
    zoneId: string,
    ownerId: string,
    storeId: string,
    data: Partial<{
      name: string;
      postalPatterns: string[];
      countryPattern: string;
      rateType: ShippingRateType;
      flatRate: number;
      tiers: ShippingTier[] | ShippingPricingConfig;
      currency: string;
      priority: number;
    }>
  ): Promise<ShippingZone> {
    // Fetch existing zone to preserve required fields
    const existing = await this.get(zoneId);
    if (!existing) {
      throw new Error('Shipping zone not found');
    }

    const documentData: Record<string, unknown> = {
      storeId: identifierStringToDocumentBytes(storeId),
      name: data.name ?? existing.name,
      rateType: data.rateType ?? existing.rateType
    };

    // A key given as undefined clears that optional field (a worldwide zone, a free
    // rate, no weight pricing); an omitted key keeps the stored value.
    if ('postalPatterns' in data) documentData.postalPatterns = data.postalPatterns && JSON.stringify(data.postalPatterns);
    if ('countryPattern' in data) documentData.countryPattern = data.countryPattern;
    if ('flatRate' in data) documentData.flatRate = data.flatRate;
    if ('tiers' in data) documentData.tiers = data.tiers && JSON.stringify(data.tiers);
    if ('currency' in data) documentData.currency = data.currency;
    if ('priority' in data) documentData.priority = data.priority;

    return this.update(zoneId, ownerId, documentData);
  }

  /**
   * Delete a shipping zone
   */
  async deleteZone(zoneId: string, ownerId: string): Promise<boolean> {
    return this.delete(zoneId, ownerId);
  }

  // =========================================================================
  // Rate Calculation Methods
  // =========================================================================

  /**
   * Find the matching zone for a shipping address
   */
  findMatchingZone(zones: ShippingZone[], address: ShippingAddress): ShippingZone | null {
    return this.matchingZones(zones, address)[0] ?? null;
  }

  /** Every zone covering `address`, by priority (lower = higher priority; ties keep `zones` order). */
  private matchingZones(zones: readonly ShippingZone[], address: ShippingAddress): ShippingZone[] {
    return [...zones]
      .sort((a, b) => a.priority - b.priority)
      .filter((zone) => this.matchesPostalPatterns(zone.postalPatterns, address.postalCode)
        && this.matchesCountryPattern(zone.countryPattern, address.country, address.state, address.postalCode));
  }

  /**
   * Check if postal code matches any of the patterns
   */
  private matchesPostalPatterns(patterns: string[] | undefined, postalCode: string): boolean {
    if (!patterns || patterns.length === 0) {
      return true; // No patterns = matches all
    }

    for (const pattern of patterns) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(postalCode)) {
          return true;
        }
      } catch {
        logger.error('Invalid postal pattern:', pattern);
      }
    }

    return false;
  }

  /**
   * Check if country (and optionally state/postal) matches the pattern
   * Pattern formats:
   *   "US"        - matches country US (any state)
   *   "US|CA"     - regex: matches US OR CA
   *   "US.IL"     - matches US, state IL specifically (2-char suffix = state)
   *   "US.6"      - matches US, zip starting with "6" (non-2-char suffix = postal prefix)
   *   "US.606"    - matches US, zip starting with "606"
   *   "CA.ON"     - matches Canada, Ontario (2-char suffix = province)
   *   "CA.K"      - matches Canada, postal starting with "K"
   *   "GB.SW"     - matches UK, postal starting with "SW" (2-char, but UK postal prefixes)
   *   "US.IL|US.6" - matches Illinois OR zip prefix 6
   */
  private matchesCountryPattern(
    pattern: string | undefined,
    country: string,
    state?: string,
    postalCode?: string
  ): boolean {
    if (!pattern) {
      return true; // No pattern = matches all
    }

    // Check if pattern uses dot notation for country.suffix
    // We need to handle this before regex to properly escape dots
    if (pattern.includes('.')) {
      // Convert "US.IL" to a test function, handle regex OR patterns like "US.IL|US.CA"
      const parts = pattern.split('|');
      for (const part of parts) {
        if (part.includes('.')) {
          const [patternCountry, patternSuffix] = part.split('.');
          const countryMatches = patternCountry.toUpperCase() === country.toUpperCase();

          if (!countryMatches) continue;

          // Length-based detection:
          // - Exactly 2 chars = state/province code
          // - Anything else = postal prefix
          if (patternSuffix.length === 2) {
            // State/province match
            if (state?.toUpperCase() === patternSuffix.toUpperCase()) {
              return true;
            }
          } else {
            // Postal prefix match (case-insensitive for UK/CA postal codes)
            if (postalCode?.toUpperCase().startsWith(patternSuffix.toUpperCase())) {
              return true;
            }
          }
        } else {
          // Part without dot - just match country
          if (part.toUpperCase() === country.toUpperCase()) {
            return true;
          }
        }
      }
      return false;
    }

    // No dots - use regex matching (supports patterns like "US|CA")
    try {
      const regex = new RegExp(`^(${pattern})$`, 'i');
      return regex.test(country);
    } catch {
      logger.error('Invalid country pattern:', pattern);
      return false;
    }
  }

  /**
   * Calculate shipping rate for a zone
   *
   * Supports both legacy tier format and new combined pricing format.
   * Combined formula: shipping = (baseRate + weight × weightRate) × multiplier
   */
  calculateRate(zone: ShippingZone, params: { totalWeight?: number; subtotal?: number }): number {
    // Check if tiers contains combined pricing config (object with weightRate or subtotalMultipliers)
    const pricingConfig = this.parsePricingConfig(zone.tiers);

    if (pricingConfig) {
      // New combined pricing format
      const baseRate = zone.flatRate || 0;
      const weightCharge = this.calculateWeightCharge(
        pricingConfig,
        params.totalWeight || 0
      );
      const multiplier = this.findMultiplier(
        pricingConfig.subtotalMultipliers,
        params.subtotal || 0
      );

      return Math.round((baseRate + weightCharge) * (multiplier / 100));
    }

    // Legacy format - use existing logic
    switch (zone.rateType) {
      case 'flat':
        return zone.flatRate || 0;

      case 'weight_tiered':
        return this.findLegacyTierRate(zone.tiers as ShippingTier[] | undefined, params.totalWeight || 0);

      case 'price_tiered':
        return this.findLegacyTierRate(zone.tiers as ShippingTier[] | undefined, params.subtotal || 0);

      default:
        return 0;
    }
  }

  /**
   * Parse tiers field to detect pricing format
   * Returns ShippingPricingConfig if new format, null if legacy array format
   */
  private parsePricingConfig(tiers: ShippingTier[] | ShippingPricingConfig | undefined): ShippingPricingConfig | null {
    if (!tiers) {
      return null;
    }

    // If it's an array, it's the legacy tier format
    if (Array.isArray(tiers)) {
      return null;
    }

    // Check if it's the new object format (has weightRate or subtotalMultipliers)
    if (typeof tiers === 'object' && ('weightRate' in tiers || 'subtotalMultipliers' in tiers)) {
      return tiers as ShippingPricingConfig;
    }

    return null;
  }

  /**
   * Calculate weight-based charge
   * Weight is in grams (from cart), converted to zone's unit for calculation
   */
  private calculateWeightCharge(config: ShippingPricingConfig, weightInGrams: number): number {
    if (!config.weightRate || config.weightRate <= 0) {
      return 0;
    }

    const unit = config.weightUnit || 'lb';
    const weightInUnit = gramsToUnit(weightInGrams, unit);

    return Math.round(weightInUnit * config.weightRate);
  }

  /**
   * Find the multiplier percentage for a subtotal
   * Returns 100 (normal rate) if no multipliers or subtotal exceeds all thresholds
   */
  private findMultiplier(multipliers: SubtotalMultiplier[] | undefined, subtotal: number): number {
    if (!multipliers || multipliers.length === 0) {
      return 100;
    }

    // Sort by upTo ascending (null = infinity goes last)
    const sorted = [...multipliers].sort((a, b) => {
      if (a.upTo === null) return 1;
      if (b.upTo === null) return -1;
      return a.upTo - b.upTo;
    });

    for (const tier of sorted) {
      if (tier.upTo === null || subtotal <= tier.upTo) {
        return tier.percent;
      }
    }

    // If subtotal exceeds all defined tiers, return 100% (normal rate)
    return 100;
  }

  /**
   * Find the rate for a value within legacy tiers
   */
  private findLegacyTierRate(tiers: ShippingTier[] | undefined, value: number): number {
    if (!tiers || tiers.length === 0) {
      return 0;
    }

    // Sort tiers by min value
    const sortedTiers = [...tiers].sort((a, b) => a.min - b.min);

    for (const tier of sortedTiers) {
      if (value >= tier.min && value <= tier.max) {
        return tier.rate;
      }
    }

    // If above all tiers, use the highest tier's rate
    const highestTier = sortedTiers[sortedTiers.length - 1];
    if (value > highestTier.max) {
      return highestTier.rate;
    }

    // If below all tiers, use the lowest tier's rate
    return sortedTiers[0].rate;
  }

  /**
   * A cart's shipping to `address` (docs/STOREFRONT_V9.md). Each line ships
   * under the store's zones its item names (ids that are not among `zones`,
   * the store's, are ignored), or under every zone when it names none; an item
   * whose named zones are all gone ships nowhere. The lines a zone takes are
   * priced together as one shipment, so the cart is kept to as few shipments
   * as it can be: the lines with the fewest covering zones choose first, and
   * a line takes the highest-priority zone an earlier line already chose when
   * one covers it, else its own highest-priority zone. With no item naming
   * zones every line takes the first matching zone, so this is exactly the
   * one-zone price of the whole cart.
   */
  quoteShipping(zones: ShippingZone[], lines: readonly ShippingLine[], address: ShippingAddress): ShippingQuote {
    const candidates = lines.map((line) => {
      const named = line.zoneIds && line.zoneIds.length > 0 ? new Set(line.zoneIds) : null;
      // Filtered from the store's own list, so equal priorities break the same way as for an unrestricted line.
      return this.matchingZones(named ? zones.filter((zone) => named.has(zone.id)) : zones, address);
    });
    const chosen = new Set<string>();
    const zoneOf = new Map<number, ShippingZone>();
    // Stable: lines with as many covering zones choose in cart order.
    const order = lines.map((_, index) => index).sort((a, b) => candidates[a].length - candidates[b].length);
    for (const index of order) {
      const matches = candidates[index];
      const zone = matches.find((match) => chosen.has(match.id)) ?? matches[0];
      if (!zone) continue;
      chosen.add(zone.id);
      zoneOf.set(index, zone);
    }

    // Shipments, and the lines in each, in cart order.
    const groups = new Map<string, { zone: ShippingZone; lines: ShippingLine[] }>();
    const unshippable: ShippingLine[] = [];
    lines.forEach((line, index) => {
      const zone = zoneOf.get(index);
      if (!zone) {
        unshippable.push(line);
        return;
      }
      const group = groups.get(zone.id) ?? { zone, lines: [] };
      group.lines.push(line);
      groups.set(zone.id, group);
    });
    const shipments: Shipment[] = [...groups.values()].map(({ zone, lines: carried }) => ({
      zone,
      lines: carried,
      cost: this.calculateRate(zone, {
        totalWeight: carried.reduce((sum, line) => sum + line.weight, 0),
        subtotal: carried.reduce((sum, line) => sum + line.subtotal, 0)
      })
    }));
    return { shipments, unshippable, cost: shipments.reduce((sum, shipment) => sum + shipment.cost, 0) };
  }
}

/** A region code as its English name ("CA" → "Canada"), or the code as entered when it is not one. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What checkout tells a buyer when nothing in the cart can ship to the address. */
export const SHIPPING_UNAVAILABLE_MESSAGE = 'We cannot ship to this address. Please check your shipping address.';
/** The listings, or the zones a limited item needs, could not be read: the restriction cannot be checked, so checkout waits. */
export const SHIPPING_CHECK_FAILED_MESSAGE = "We couldn't check shipping for your cart. Please try again.";

/** Checkout's shipping for a cart: its quote (null: unpriced, free) and why it cannot go on (null: it can). */
export interface ShippingCheck {
  quote: ShippingQuote | null;
  problem: string | null;
}

const isLimited = (line: ShippingLine) => Boolean(line.zoneIds && line.zoneIds.length > 0);

/**
 * What placing an order does after checking shipping again, fresh:
 * `proceed`; `review` (the cost differs from what the buyer saw, so the new
 * quote is shown and the buyer submits again); `back` (a line no longer ships,
 * or it could not be checked: back to the shipping step).
 */
export type FinalShipping = { kind: 'proceed' } | { kind: 'review'; message: string } | { kind: 'back'; message: string };

/**
 * The final check before an order is placed. `fresh` is `checkShipping` on
 * freshly read lines and zones, or null when they could not be read;
 * `previousCost` is the shipping the buyer reviewed.
 */
export function finalShippingCheck(previousCost: number, fresh: ShippingCheck | null, formatCost: (cost: number) => string): FinalShipping {
  if (!fresh) return { kind: 'back', message: SHIPPING_CHECK_FAILED_MESSAGE };
  if (fresh.problem) return { kind: 'back', message: fresh.problem };
  const cost = fresh.quote?.cost ?? 0;
  return cost === previousCost ? { kind: 'proceed' } : { kind: 'review', message: `Shipping changed to ${formatCost(cost)}. Please review your order.` };
}

/**
 * The shipping step's verdict on `lines` to `address`, given the store's
 * `zones` (null: they could not be read). A store with no zones, or zones that
 * could not be read, has always checked out without a shipping charge; that
 * holds only for lines that may ship under any zone. With no zones, a line
 * limited to some ships nowhere; with zones unreadable, its limit cannot be
 * checked, so checkout waits for them.
 */
export function checkShipping(zones: ShippingZone[] | null, lines: readonly ShippingLine[], address: ShippingAddress): ShippingCheck {
  const limited = lines.some(isLimited);
  if (zones === null) return { quote: null, problem: limited ? SHIPPING_CHECK_FAILED_MESSAGE : null };
  const quote = zones.length > 0
    ? shippingZoneService.quoteShipping(zones, lines, address)
    : { shipments: [], unshippable: lines.filter(isLimited), cost: 0 };
  return { quote, problem: shippingProblem(quote, address.country) };
}

/**
 * Why `quote` cannot be checked out to `country`, or null when every line
 * ships. A line that may use any zone and still ships nowhere means the store
 * does not ship there at all; otherwise only items limited to some zones miss
 * the address, and the message names them so the buyer can remove them.
 */
export function shippingProblem(quote: ShippingQuote, country: string): string | null {
  if (quote.unshippable.length === 0) return null;
  if (quote.unshippable.some((line) => !line.zoneIds || line.zoneIds.length === 0)) return SHIPPING_UNAVAILABLE_MESSAGE;
  const titles = [...new Set(quote.unshippable.map((line) => line.title))];
  const one = titles.length === 1;
  return `${listNames(titles)} ${one ? "doesn't" : "don't"} ship to ${countryName(country)}. Remove ${one ? 'it' : 'them'} from your cart to continue.`;
}

export const shippingZoneService = new ShippingZoneService();
