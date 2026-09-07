/**
 * Weight Conversion Utilities
 *
 * Item weights are stored in grams in the contract.
 * These utilities convert between grams and seller-defined units.
 */

import { WEIGHT_UNITS } from '../types'

/**
 * Convert grams to a specified weight unit
 * @param grams Weight in grams
 * @param unit Target unit (lb, kg, oz, g, or custom)
 * @returns Weight in target unit
 */
export function gramsToUnit(grams: number, unit: string): number {
  const gramsPerUnit = WEIGHT_UNITS[unit.toLowerCase()]
  if (gramsPerUnit) {
    return grams / gramsPerUnit
  }
  // For custom units (like "item"), treat weight as-is (1:1)
  return grams
}
