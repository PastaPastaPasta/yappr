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

/**
 * Convert from a unit to grams
 * @param value Weight in the source unit
 * @param unit Source unit
 * @returns Weight in grams
 */
export function unitToGrams(value: number, unit: string): number {
  const gramsPerUnit = WEIGHT_UNITS[unit.toLowerCase()]
  if (gramsPerUnit) {
    return value * gramsPerUnit
  }
  return value
}

/**
 * Format weight for display with unit
 * @param grams Weight in grams
 * @param unit Display unit
 * @param decimals Number of decimal places
 * @returns Formatted string like "2.5 lb"
 */
export function formatWeight(grams: number, unit: string, decimals = 2): string {
  const value = gramsToUnit(grams, unit)
  return `${value.toFixed(decimals)} ${unit}`
}

/**
 * Get display label for weight unit
 */
export function getWeightUnitLabel(unit: string): string {
  const labels: Record<string, string> = {
    'g': 'grams',
    'oz': 'ounces',
    'lb': 'pounds',
    'kg': 'kilograms',
  }
  return labels[unit.toLowerCase()] || unit
}
