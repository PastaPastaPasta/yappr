/**
 * Shipping Zone Service
 *
 * Manages shipping zones and rate calculation.
 * Supports flat, weight-tiered, and price-tiered rates.
 */

import { BaseDocumentService } from './document-service';
import { YAPPR_STOREFRONT_CONTRACT_ID, STOREFRONT_DOCUMENT_TYPES } from '../constants';
import { identifierToBase58, stringToIdentifierBytes } from './sdk-helpers';
import type {
  ShippingZone,
  ShippingZoneDocument,
  ShippingRateType,
  ShippingTier,
  ShippingPricingConfig,
  SubtotalMultiplier,
  ShippingAddress
} from '../types';
import { gramsToUnit } from '../utils/weight';

class ShippingZoneService extends BaseDocumentService<ShippingZone> {
  constructor() {
    super(STOREFRONT_DOCUMENT_TYPES.SHIPPING_ZONE, YAPPR_STOREFRONT_CONTRACT_ID);
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
          console.error('Failed to parse postalPatterns:', data.postalPatterns);
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
          console.error('Failed to parse tiers:', data.tiers);
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
      storeId: stringToIdentifierBytes(storeId),
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
      storeId: stringToIdentifierBytes(storeId),
      name: data.name ?? existing.name,
      rateType: data.rateType ?? existing.rateType
    };

    if (data.postalPatterns !== undefined) documentData.postalPatterns = JSON.stringify(data.postalPatterns);
    if (data.countryPattern !== undefined) documentData.countryPattern = data.countryPattern;
    if (data.flatRate !== undefined) documentData.flatRate = data.flatRate;
    if (data.tiers !== undefined) documentData.tiers = JSON.stringify(data.tiers);
    if (data.currency !== undefined) documentData.currency = data.currency;
    if (data.priority !== undefined) documentData.priority = data.priority;

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
    // Sort by priority (lower = higher priority)
    const sortedZones = [...zones].sort((a, b) => a.priority - b.priority);

    for (const zone of sortedZones) {
      const matchesPostal = this.matchesPostalPatterns(zone.postalPatterns, address.postalCode);
      const matchesCountry = this.matchesCountryPattern(
        zone.countryPattern,
        address.country,
        address.state,
        address.postalCode
      );

      if (matchesPostal && matchesCountry) {
        return zone;
      }
    }

    return null;
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
        console.error('Invalid postal pattern:', pattern);
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
      console.error('Invalid country pattern:', pattern);
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
   * Calculate shipping cost for an order
   */
  async calculateShipping(
    storeId: string,
    address: ShippingAddress,
    params: { totalWeight?: number; subtotal?: number }
  ): Promise<{ zone: ShippingZone | null; cost: number }> {
    const zones = await this.getByStore(storeId);
    const zone = this.findMatchingZone(zones, address);

    if (!zone) {
      return { zone: null, cost: 0 };
    }

    const cost = this.calculateRate(zone, params);
    return { zone, cost };
  }
}

export const shippingZoneService = new ShippingZoneService();
