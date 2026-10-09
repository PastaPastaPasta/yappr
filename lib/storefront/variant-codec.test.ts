import { describe, expect, it } from 'vitest'
import type { ItemVariants } from '@/lib/types'
import {
  CombinationLimitError, addAxis, addOption, clampImages, combinationForSelection, combinationImageUrl, decodeVariants, emptyVariants, encodeVariants,
  findCombination, missingCombinations, moveAxis, moveOption, optionIdsLeft, orderLineVariantLabel, priceRange, removeAxis, removeCombination, removeOption, renameAxis,
  renameOption, restoreCombinations, selectableOptionIds, setStockTracking, tracksStock, updateCombination,
  updateCombinations, variantIdOf, variantLabel, variantProblems, variantsFromRows, type VariantRow,
} from './variant-codec'
import { encodeLegacyVariants } from './legacy-variants'
import { ITEM_TRANSITION_BUDGET, ITEM_TRANSITION_OVERHEAD, VARIANT_LIMITS, itemSizeError, itemTransitionBytes, platformValueBytes } from './storefront-contract'

/** `value`, failing the test when it is missing. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

const COLORS = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink']
const PACKS = ['Single Piece', '4 Pack']

/** The seller's listing that outgrew v6: 7 primary colours × 2 pack sizes, prices 100 / 353, stock and SKU per combination. */
function sellerExample(): ItemVariants {
  const rows: VariantRow[] = COLORS.flatMap((color, c) => PACKS.map((pack, p) => ({
    optionNames: [color, pack], price: p === 0 ? 100 : 353, stock: 10 + c, sku: `TOY-${color.slice(0, 3).toUpperCase()}-${p === 0 ? 'S' : '4'}`,
  })))
  return variantsFromRows(['Primary color', 'Pack Size'], rows).variants as ItemVariants
}

/** 5 axes (4, 5, 5, 2, 2 options) and the first 100 of their 400 combinations, each with stock and a SKU. */
function hundredCombinations(): ItemVariants {
  const sizes = [4, 5, 5, 2, 2]
  const axes = ['Colour', 'Size', 'Material', 'Finish', 'Pack']
  const rows: VariantRow[] = []
  for (let n = 0; rows.length < 100; n += 1) {
    let rest = n
    const optionNames = sizes.map((size, a) => { const o = rest % size; rest = Math.floor(rest / size); return `${axes[a]} ${o + 1}` })
    rows.push({ optionNames, price: 1000 + 25 * rows.length, stock: rows.length % 7, sku: `SKU-${String(rows.length).padStart(3, '0')}` })
  }
  return variantsFromRows(axes, rows).variants as ItemVariants
}

const shirt = (): ItemVariants => variantsFromRows(['Color', 'Size'], [
  { optionNames: ['Red', 'S'], price: 100 }, { optionNames: ['Red', 'L'], price: 120 },
  { optionNames: ['Blue', 'S'], price: 100 }, { optionNames: ['Blue', 'L'], price: 120 },
]).variants as ItemVariants
// Red=1 S=2 L=3 Blue=4
const DEFAULTS = { price: 500 }

describe('variant identity', () => {
  it('is the sorted, dot-joined option id set', () => {
    expect(variantIdOf([9, 3])).toBe('3.9')
    expect(variantIdOf([3, 9])).toBe('3.9')
    expect(variantIdOf([12, 2, 100])).toBe('2.12.100')
  })

  it('looks a combination up by id and by a per-axis selection', () => {
    const table = shirt()
    expect(findCombination(table, '3.4')?.price).toBe(120)
    expect(combinationForSelection(table, [4, 3])?.id).toBe('3.4')
    expect(combinationForSelection(table, [4, undefined])).toBeUndefined()
    expect(findCombination(table, '1.4')).toBeUndefined()
    expect(variantLabel(table, defined(findCombination(table, '3.4')))).toBe('Blue / L')
  })

  it('keeps ids across renames and reorders of options and axes', () => {
    const table = moveAxis(moveOption(renameAxis(renameOption(shirt(), 1, 'Crimson'), 0, 'Colour'), 4, -1), 0, 1)
    expect(table.axes.map((axis) => axis.name)).toEqual(['Size', 'Colour'])
    expect(table.axes[1].options.map((option) => option.name)).toEqual(['Blue', 'Crimson'])
    expect(table.combinations.map((combination) => combination.id).sort()).toEqual(['1.2', '1.3', '2.4', '3.4'])
    expect(findCombination(table, '1.3')?.optionIds).toEqual([3, 1])
    expect(variantLabel(table, defined(findCombination(table, '1.3')))).toBe('L / Crimson')
    expect(variantProblems(table, { imageCount: 0 })).toEqual([])
  })

  it('shows an order line its whole variant name, however long, and nothing for a non-string', () => {
    const long = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'Size L'].join(' / ')
    expect(orderLineVariantLabel({ variantLabel: long })).toBe(long)
    expect(orderLineVariantLabel({ variantKey: `${'x'.repeat(130)}|Large` })).toBe(`${'x'.repeat(130)} / Large`)
    expect(orderLineVariantLabel({ variantLabel: 7 })).toBeUndefined()
    expect(orderLineVariantLabel({ variantLabel: '' })).toBeUndefined()
  })
})

describe('encode and decode', () => {
  it('round-trips the seller example, stock and SKUs included', () => {
    const table = sellerExample()
    expect(table.combinations).toHaveLength(14)
    const stored = encodeVariants(table)
    expect(stored.axes).toEqual(['Primary color', 'Pack Size'])
    // First-seen order: Red=1, Single Piece=2, 4 Pack=3, Orange=4, …
    expect(stored.optionIds).toEqual([1, 4, 5, 6, 7, 8, 9, 2, 3])
    expect(stored.optionAxes).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1])
    expect(stored.selectors[1]).toEqual(Uint8Array.of(1, 3))
    expect(stored.stocks).toHaveLength(14)
    expect(stored.weights).toBeUndefined()
    expect(decodeVariants(stored)).toEqual(table)
  })

  it('writes optional lists only when used, with neutral fillers', () => {
    let table = updateCombination(shirt(), '1.2', { sku: 'R-S', weight: 180, image: 2 })
    const stored = encodeVariants(table)
    expect(stored.skus).toEqual(['R-S', '', '', ''])
    expect(stored.weights).toEqual([180, 0, 0, 0])
    expect(stored.images).toEqual([2, 0, 0, 0])
    expect(stored.stocks).toBeUndefined()
    expect(decodeVariants(stored)).toEqual(table)
    table = setStockTracking(table, true)
    expect(encodeVariants(table).stocks).toEqual([0, 0, 0, 0])
  })

  it('reads the shapes a query hands back: bigints, decimal strings, byte lists', () => {
    const stored = encodeVariants(shirt())
    const asRead = {
      ...stored,
      optionIds: stored.optionIds.map(BigInt),
      prices: stored.prices.map(String),
      nextOptionId: BigInt(stored.nextOptionId),
      selectors: stored.selectors.map((selector) => Array.from(selector)),
    }
    expect(decodeVariants(asRead)).toEqual(shirt())
  })

  it('drops malformed combinations instead of showing them wrongly', () => {
    const stored = encodeVariants(shirt())
    const decoded = decodeVariants({
      ...stored,
      selectors: [Uint8Array.of(1, 2), Uint8Array.of(2, 1), Uint8Array.of(1), Uint8Array.of(1, 2), Uint8Array.of(4, 9)],
      prices: [100, 100, 100, 100, 100],
    })
    expect(decoded?.combinations.map((combination) => combination.id)).toEqual(['1.2'])
  })

  it('reads no table from nothing usable', () => {
    for (const raw of [undefined, null, 'json', [], {}, { ...encodeVariants(shirt()), options: ['a'] }, { ...encodeVariants(shirt()), axes: [] },
      { ...encodeVariants(shirt()), selectors: [Uint8Array.of(9, 9)], prices: [1] }]) {
      expect(decodeVariants(raw)).toBeUndefined()
    }
  })

  it('never hands out an id below one already used', () => {
    const decoded = decodeVariants({ ...encodeVariants(shirt()), nextOptionId: 2 })
    expect(decoded?.nextOptionId).toBe(5)
  })
})

describe('editing', () => {
  it('builds the grid from the first option type', () => {
    const table = addAxis(emptyVariants(), 'Size', ['S', 'M', 'L'], { price: 100, stock: 3 })
    expect(table.combinations.map((combination) => [combination.id, combination.price, combination.stock])).toEqual([['1', 100, 3], ['2', 100, 3], ['3', 100, 3]])
    expect(table.nextOptionId).toBe(4)
  })

  it('carries everything into a new single-option type, and price only into several', () => {
    const base = updateCombination(setStockTracking(shirt(), true), '1.2', { stock: 7, sku: 'R-S' })
    const one = addAxis(base, 'Material', ['Cotton'], DEFAULTS)
    expect(findCombination(one, '1.2.5')).toMatchObject({ price: 100, stock: 7, sku: 'R-S' })
    const two = addAxis(base, 'Material', ['Cotton', 'Silk'], { price: 1, stock: 0 })
    expect(findCombination(two, '1.2.5')).toMatchObject({ price: 100, stock: 0 })
    expect(findCombination(two, '1.2.5')?.sku).toBeUndefined()
    expect(two.combinations).toHaveLength(8)
  })

  it('merges combinations when an option type goes, and empties the table with the last', () => {
    const merged = removeAxis(shirt(), 1)
    expect(merged.combinations.map((combination) => [combination.id, combination.price])).toEqual([['1', 100], ['4', 100]])
    const empty = removeAxis(removeAxis(shirt(), 1), 0)
    expect(empty.axes).toEqual([])
    expect(empty.nextOptionId).toBe(5)
  })

  it('never reuses an id after a removal', () => {
    const table = addOption(removeOption(shirt(), 4), 0, 'Teal', DEFAULTS)
    expect(table.axes[0].options.map((option) => [option.id, option.name])).toEqual([[1, 'Red'], [5, 'Teal']])
    expect(table.combinations.map((combination) => combination.id)).toEqual(['1.2', '1.3', '2.5', '3.5'])
  })

  it('offers a new option only with the patterns already offered, and restores missing ones on request', () => {
    const trimmed = removeCombination(shirt(), '3.4')
    const added = addOption(trimmed, 1, 'XL', DEFAULTS)
    expect(added.combinations.map((combination) => combination.id).sort()).toEqual(['1.2', '1.3', '1.5', '2.4', '4.5'])
    expect(missingCombinations(added)).toEqual([[4, 3]])
    expect(findCombination(restoreCombinations(added, DEFAULTS), '3.4')?.price).toBe(500)
  })

  it('removes an option type with its last option', () => {
    const table = removeOption(defined(variantsFromRows(['Color', 'Size'], [{ optionNames: ['Red', 'S'], price: 1 }, { optionNames: ['Blue', 'S'], price: 2 }]).variants), 2)
    expect(table.axes.map((axis) => axis.name)).toEqual(['Color'])
    expect(table.combinations.map((combination) => combination.id)).toEqual(['1', '3'])
  })

  it('applies bulk price and stock edits, to all or to one option', () => {
    const table = updateCombinations(updateCombinations(shirt(), { price: 900 }), { price: 1500, stock: 2 }, 3)
    expect(table.combinations.map((combination) => [combination.id, combination.price, combination.stock])).toEqual([
      ['1.2', 900, undefined], ['1.3', 1500, 2], ['2.4', 900, undefined], ['3.4', 1500, 2],
    ])
    expect(tracksStock(setStockTracking(table, false))).toBe(false)
  })

  it('refuses an edit past the combination cap before building the grid', () => {
    // Five option types of 50 options, none offered: one more option would mean 50^4 combinations.
    const axes = Array.from({ length: 5 }, (_, a) => ({ name: `T${a}`, options: Array.from({ length: 50 }, (_, o) => ({ id: a * 50 + o + 1, name: `o${o}` })) }))
    const bare: ItemVariants = { axes, combinations: [], nextOptionId: 251 }
    const limitOf = (edit: () => unknown) => {
      try {
        edit()
      } catch (error) {
        return error instanceof CombinationLimitError ? error.size : -1
      }
      return 0
    }
    expect(limitOf(() => addOption(bare, 0, 'new', DEFAULTS))).toBe(50 ** 4)
    expect(limitOf(() => restoreCombinations(bare, DEFAULTS))).toBe(50 ** 5)
    expect(limitOf(() => addAxis(shirt(), 'Pack', Array.from({ length: 65 }, (_, n) => `p${n}`), DEFAULTS))).toBe(4 * 65)
    expect(limitOf(() => addAxis(shirt(), 'Pack', ['one', 'two'], DEFAULTS))).toBe(0)
  })

  it('never reuses an id: once the 254 run out, no option can be added', () => {
    const table = { ...shirt(), nextOptionId: VARIANT_LIMITS.maxOptionId }
    expect(optionIdsLeft(table)).toBe(1)
    const grown = addOption(table, 1, 'M', DEFAULTS)
    expect(grown.axes[1].options.map((option) => option.id)).toEqual([2, 3, 254])
    expect(optionIdsLeft(grown)).toBe(0)
    expect(variantProblems(grown, { imageCount: 0 })).toEqual([])
    expect(() => addOption(grown, 1, 'XL', DEFAULTS)).toThrow(/list the product again/)
    expect(() => addAxis(grown, 'Fit', ['Slim'], DEFAULTS)).toThrow(/list the product again/)
  })

  it('forgets images the listing no longer has', () => {
    const table = clampImages(updateCombination(shirt(), '1.2', { image: 3 }), 2)
    expect(findCombination(table, '1.2')?.image).toBeUndefined()
  })
})

describe('the buyer picker', () => {
  it('offers only options that complete an in-stock combination', () => {
    const table = updateCombination(updateCombination(setStockTracking(removeCombination(shirt(), '3.4'), true), '1.2', { stock: 4 }), '2.4', { stock: 0 })
    expect([...selectableOptionIds(table, 1, [1, undefined])]).toEqual([2])
    expect([...selectableOptionIds(table, 1, [4, undefined])]).toEqual([])
    expect([...selectableOptionIds(table, 0, [undefined, undefined])]).toEqual([1])
  })

  it('gives a price range and a combination image', () => {
    expect(priceRange(sellerExample())).toEqual({ min: 100, max: 353 })
    expect(priceRange(emptyVariants())).toEqual({ min: 0, max: 0 })
    expect(combinationImageUrl(['a', 'b'], { image: 2 })).toBe('b')
    expect(combinationImageUrl(['a', 'b'], {})).toBe('a')
    expect(combinationImageUrl(undefined, undefined)).toBeUndefined()
  })
})

describe('validation', () => {
  const problems = (table: ItemVariants, imageCount = 0) => variantProblems(table, { imageCount })

  it('accepts the seller example and the 5-axis, 100-combination table', () => {
    expect(problems(sellerExample())).toEqual([])
    expect(problems(hundredCombinations())).toEqual([])
  })

  it('refuses what the contract would, in words for the seller', () => {
    const table = shirt()
    expect(problems(emptyVariants())[0]).toMatch(/at least one option type/)
    expect(problems(renameAxis(table, 1, 'color'))[0]).toMatch(/both called/)
    expect(problems(renameOption(table, 4, 'red'))[0]).toMatch(/twice/)
    expect(problems(renameOption(table, 4, 'x'.repeat(41)))[0]).toMatch(/at most 40 characters/)
    expect(problems(updateCombination(table, '1.2', { price: -1 }))[0]).toMatch(/valid price/)
    expect(problems(updateCombination(table, '1.2', { stock: 3 }))[0]).toMatch(/every combination or for none/)
    expect(problems(updateCombination(table, '1.2', { sku: 'S'.repeat(33) }))[0]).toMatch(/SKUs/)
    expect(problems(updateCombination(table, '1.2', { image: 3 }), 2)[0]).toMatch(/image/)
    expect(problems({ ...table, combinations: [...table.combinations, table.combinations[0]] })[0]).toMatch(/twice/)
    expect(problems({ ...table, nextOptionId: 3 })[0]).toMatch(/numbered incorrectly/)
    const sixAxes = ['A', 'B', 'C', 'D', 'E', 'F'].reduce((t, name) => addAxis(t, name, ['x'], DEFAULTS), emptyVariants())
    expect(problems(sixAxes)[0]).toMatch(/at most 5 option types/)
  })

  it('lets a v1–v6 table track some combinations, but not hold "|" or weights', () => {
    const table = updateCombination(shirt(), '1.2', { stock: 3 })
    expect(variantProblems(table, { imageCount: 0, legacy: true })).toEqual([])
    expect(variantProblems(renameOption(table, 1, 'Red|Pink'), { imageCount: 0, legacy: true })[0]).toMatch(/cannot contain/)
    expect(variantProblems(updateCombination(table, '1.2', { weight: 5 }), { imageCount: 0, legacy: true })[0]).toMatch(/weights/)
  })

  it('keeps a v1–v6 listing editable past the v7 caps (long SKUs and compound option names the old import wrote)', () => {
    const compound = renameOption(updateCombination(shirt(), '1.2', { sku: 'S'.repeat(37) }), 1, 'Primary color: Red · Pack Size: Single Piece')
    expect(variantProblems(compound, { imageCount: 0, legacy: true })).toEqual([])
    expect(variantProblems(compound, { imageCount: 0 })).toHaveLength(2)
  })
})

describe('building from rows (the import)', () => {
  it('names options in first-seen order and never invents a combination', () => {
    const { variants } = variantsFromRows(['Color', 'Size'], [{ optionNames: ['Red', 'S'], price: 1 }, { optionNames: ['Blue', 'L'], price: 2 }])
    expect(variants?.combinations.map((combination) => combination.id)).toEqual(['1.2', '3.4'])
    expect(missingCombinations(defined(variants))).toHaveLength(2)
  })

  it('reports a repeated combination', () => {
    expect(variantsFromRows(['Size'], [{ optionNames: ['S'], price: 1 }, { optionNames: ['S'], price: 2 }])).toEqual({ duplicate: 'S' })
  })
})

describe('the whole-transition size budget', () => {
  // Measured with the beta.3 SDK (unsigned create transitions of storeItem with
  // an action-fee agreement): the estimate is exact up to a 154–159 B envelope.
  it('matches the platform Value encoding of real transitions', () => {
    const storeId = new Uint8Array(32)
    expect(platformValueBytes({ storeId, title: 'T', status: 'active', currency: 'USD' })).toBe(86)
    expect(platformValueBytes({ storeId, title: 'T', status: 'active', currency: 'USD', description: 'x'.repeat(2000) })).toBe(2103)
    expect(platformValueBytes({ storeId, title: 'T', status: 'active', currency: 'USD', basePrice: 300, stockQuantity: 70000, weight: 5, sku: 'abc', tags: ['a', 'b'] })).toBe(156)
    expect(ITEM_TRANSITION_OVERHEAD).toBeGreaterThanOrEqual(159 + 66)
  })

  it('fits the seller example and 100 combinations easily, and refuses a listing past the budget', () => {
    const fields = (variants: ItemVariants) => ({ storeId: new Uint8Array(32), title: 'Squishy toy', status: 'active', currency: 'USD', variants: encodeVariants(variants) })
    expect(itemTransitionBytes(fields(sellerExample()))).toBeLessThan(1000)
    expect(itemTransitionBytes(fields(hundredCombinations()))).toBeLessThan(3000)
    expect(itemSizeError(fields(hundredCombinations()))).toBeNull()
    // 4 axes of 4 options: 256 combinations, each with a 32-character SKU.
    const rows: VariantRow[] = Array.from({ length: 256 }, (_, n) => ({
      optionNames: [0, 1, 2, 3].map((axis) => `o${(n >> (axis * 2)) % 4}`), price: 1_000_000 + n, stock: 100_000, sku: `${n}`.padEnd(32, 'S'),
    }))
    const full = variantsFromRows(['A', 'B', 'C', 'D'], rows).variants as ItemVariants
    expect(variantProblems(full, { imageCount: 0 })).toEqual([])
    const huge = { ...fields(full), description: 'x'.repeat(2000), imageUrls: Array.from({ length: 12 }, (_, i) => `https://example.com/${i}/${'x'.repeat(480)}`) }
    expect(itemTransitionBytes(huge)).toBeGreaterThan(ITEM_TRANSITION_BUDGET)
    expect(itemSizeError(huge)).toMatch(/too large to save as one listing/)
  })

  it('stores the seller example in a fraction of v6\'s JSON', () => {
    const v7 = platformValueBytes(encodeVariants(sellerExample()))
    const v6 = new TextEncoder().encode(encodeLegacyVariants(sellerExample())).length
    expect(v7).toBeLessThan(v6 / 2)
  })
})
