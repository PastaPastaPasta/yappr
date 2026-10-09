/**
 * The seller's variant editor (app/store/item/add): parsing what the seller
 * types into the table's units, and the edits the codec's ops do not cover
 * (images shifting when one is removed, a currency change, tidying names).
 * Pure: no React, no SDK.
 */
import type { ItemVariants, VariantCombination } from '@/lib/types'
import { fromSmallestUnit, getCurrencyDecimals, toSmallestUnit } from '@/lib/utils/format'
import { VARIANT_LIMITS } from './storefront-contract'

const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/

/** A typed price in display units ("12.50") as a smallest-unit integer, or undefined when it is not one. */
export function parsePriceInput(text: string, currency: string): number | undefined {
  const trimmed = text.trim()
  if (!DECIMAL.test(trimmed)) return undefined
  const price = toSmallestUnit(Number(trimmed), currency)
  return Number.isSafeInteger(price) && price >= 0 && price <= VARIANT_LIMITS.maxPrice ? price : undefined
}

/** A smallest-unit price as the seller types it ("12.50"). */
export function formatPriceInput(price: number, currency: string): string {
  return fromSmallestUnit(price, currency).toFixed(getCurrencyDecimals(currency))
}

/** A typed whole number from 0 to `max` (stock, grams), or undefined when it is not one. */
export function parseCountInput(text: string, max: number): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const count = Number(trimmed)
  return Number.isSafeInteger(count) && count <= max ? count : undefined
}

const nameKey = (name: string) => name.trim().toLowerCase()

/**
 * Option names typed as "S, M, L": trimmed, blanks dropped, and any name
 * already in `existing` or earlier in the list (ignoring case) left out.
 */
export function splitOptionNames(text: string, existing: readonly string[] = []): string[] {
  const seen = new Set(existing.map(nameKey))
  const names: string[] = []
  for (const part of text.split(',')) {
    const name = part.trim()
    if (!name || seen.has(nameKey(name))) continue
    seen.add(nameKey(name))
    names.push(name)
  }
  return names
}

/**
 * After the listing's image at 0-based `removedIndex` is removed: a
 * combination that showed it falls back to the default image, and one that
 * showed a later image follows it down by one.
 */
export function shiftImagesAfterRemoval(variants: ItemVariants, removedIndex: number): ItemVariants {
  const removed = removedIndex + 1
  if (!variants.combinations.some((combination) => combination.image !== undefined && combination.image >= removed)) return variants
  return {
    ...variants,
    combinations: variants.combinations.map((combination): VariantCombination => {
      if (combination.image === undefined || combination.image < removed) return combination
      if (combination.image > removed) return { ...combination, image: combination.image - 1 }
      const next = { ...combination }
      delete next.image
      return next
    }),
  }
}

/** Every price re-expressed in `to` so it reads the same as it did in `from` (the seller changed the currency). */
export function convertPrices(variants: ItemVariants, from: string, to: string): ItemVariants {
  if (from === to || getCurrencyDecimals(from) === getCurrencyDecimals(to)) return variants
  return {
    ...variants,
    combinations: variants.combinations.map((combination) => ({ ...combination, price: toSmallestUnit(fromSmallestUnit(combination.price, from), to) })),
  }
}

/** Option type and option names without surrounding spaces, as they are saved. */
export function tidyNames(variants: ItemVariants): ItemVariants {
  return {
    ...variants,
    axes: variants.axes.map((axis) => ({ name: axis.name.trim(), options: axis.options.map((option) => ({ ...option, name: option.name.trim() })) })),
  }
}

/** How many combinations every pairing of the current options makes (0 with no option types). */
export function fullGridSize(variants: ItemVariants): number {
  if (variants.axes.length === 0) return 0
  return variants.axes.reduce((size, axis) => size * axis.options.length, 1)
}

/** How many combinations of the current options are not offered (without listing them, which can be huge). */
export function missingCombinationCount(variants: ItemVariants): number {
  return Math.max(0, fullGridSize(variants) - variants.combinations.length)
}

/** Why an edit that leads to `variants` is refused (too many combinations or options), else undefined. */
export function variantGrowthProblem(variants: ItemVariants, legacy = false): string | undefined {
  const optionCount = variants.axes.reduce((total, axis) => total + axis.options.length, 0)
  // v7 caps options at 64; v1–v6 at the 254 option ids every listing has (a
  // table past 256 combinations cannot fit their JSON either).
  if (optionCount > (legacy ? VARIANT_LIMITS.maxOptionId : VARIANT_LIMITS.options)) return `A product can have at most ${legacy ? VARIANT_LIMITS.maxOptionId : VARIANT_LIMITS.options} options in all.`
  if (variants.combinations.length > VARIANT_LIMITS.combinations) return tooManyCombinations(variants.combinations.length)
  return undefined
}

/** Why an edit making `size` combinations is refused. */
export function tooManyCombinations(size: number): string {
  return `That would make ${size} combinations, and a product can offer at most ${VARIANT_LIMITS.combinations}. Use fewer options, or split it into several listings.`
}

/**
 * The price a new combination starts at: the base price the seller typed,
 * else the first combination's, else 0.
 */
export function defaultCombinationPrice(basePrice: string, currency: string, variants: ItemVariants): number {
  return (basePrice.trim() ? parsePriceInput(basePrice, currency) : undefined) ?? variants.combinations[0]?.price ?? 0
}
