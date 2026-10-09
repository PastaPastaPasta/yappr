import { describe, expect, it } from 'vitest'
import type { ItemVariants } from '@/lib/types'
import { addAxis, emptyVariants, removeCombination, updateCombination } from './variant-codec'
import {
  convertPrices, defaultCombinationPrice, formatPriceInput, fullGridSize, missingCombinationCount, parseCountInput, parsePriceInput,
  shiftImagesAfterRemoval, splitOptionNames, tidyNames, variantGrowthProblem,
} from './variant-editor-model'
import { VARIANT_LIMITS } from './storefront-contract'

/** Color (Red, Blue) × Size (S, M, L) at 1000 each. */
function grid(): ItemVariants {
  const colors = addAxis(emptyVariants(), 'Color', ['Red', 'Blue'], { price: 1000 })
  return addAxis(colors, 'Size', ['S', 'M', 'L'], { price: 1000 })
}

describe('parsePriceInput', () => {
  it('reads display units into the smallest unit', () => {
    expect(parsePriceInput('12.5', 'USD')).toBe(1250)
    expect(parsePriceInput(' 3 ', 'USD')).toBe(300)
    expect(parsePriceInput('.99', 'USD')).toBe(99)
    expect(parsePriceInput('1.', 'USD')).toBe(100)
    expect(parsePriceInput('0.00000001', 'DASH')).toBe(1)
    expect(parsePriceInput('0', 'USD')).toBe(0)
  })

  it('refuses anything that is not a price', () => {
    for (const text of ['', ' ', '.', 'abc', '-1', '1e3', '1,5', 'NaN', 'Infinity', '1.2.3']) {
      expect(parsePriceInput(text, 'USD')).toBeUndefined()
    }
    expect(parsePriceInput('9'.repeat(30), 'USD')).toBeUndefined()
  })

  it('round-trips through formatPriceInput', () => {
    expect(formatPriceInput(1250, 'USD')).toBe('12.50')
    expect(formatPriceInput(1, 'DASH')).toBe('0.00000001')
    expect(parsePriceInput(formatPriceInput(123456789, 'DASH'), 'DASH')).toBe(123456789)
  })
})

describe('parseCountInput', () => {
  it('reads whole numbers up to the cap', () => {
    expect(parseCountInput('0', 10)).toBe(0)
    expect(parseCountInput(' 7 ', 10)).toBe(7)
    expect(parseCountInput('11', 10)).toBeUndefined()
    for (const text of ['', '1.5', '-1', 'x', '1e2']) expect(parseCountInput(text, 10)).toBeUndefined()
  })
})

describe('splitOptionNames', () => {
  it('splits, trims and drops blanks and repeats, ignoring case', () => {
    expect(splitOptionNames(' S, M ,, L, m ')).toEqual(['S', 'M', 'L'])
  })

  it('leaves out names the option type already has', () => {
    expect(splitOptionNames('Red, blue, Green', ['Blue'])).toEqual(['Red', 'Green'])
  })
})

describe('shiftImagesAfterRemoval', () => {
  const withImages = (images: Array<number | undefined>): ItemVariants => {
    let variants = grid()
    variants.combinations.forEach((combination, index) => {
      variants = updateCombination(variants, combination.id, { image: images[index] })
    })
    return variants
  }

  it('drops the removed image and moves later ones down by one', () => {
    const before = withImages([1, 2, 3, undefined, 3, 2])
    const after = shiftImagesAfterRemoval(before, 1) // image 2 removed
    expect(after.combinations.map((combination) => combination.image)).toEqual([1, undefined, 2, undefined, 2, undefined])
    expect(after.combinations[1]).not.toHaveProperty('image')
    expect(after.combinations.map((combination) => combination.id)).toEqual(before.combinations.map((combination) => combination.id))
  })

  it('leaves the table alone when no combination shows the removed image or a later one', () => {
    const before = withImages([1, 1, undefined, undefined, 1, 1])
    expect(shiftImagesAfterRemoval(before, 1)).toBe(before)
  })

  it('removing the first image moves every image down', () => {
    const after = shiftImagesAfterRemoval(withImages([1, 2, 3, 4, undefined, 2]), 0)
    expect(after.combinations.map((combination) => combination.image)).toEqual([undefined, 1, 2, 3, undefined, 1])
  })
})

describe('convertPrices', () => {
  it('keeps the price the seller reads when the currency changes decimals', () => {
    const usd = grid()
    const dash = convertPrices(usd, 'USD', 'DASH')
    expect(dash.combinations.every((combination) => combination.price === 1_000_000_000)).toBe(true)
    expect(convertPrices(dash, 'DASH', 'USD').combinations[0].price).toBe(1000)
  })

  it('changes nothing between currencies with the same decimals', () => {
    const usd = grid()
    expect(convertPrices(usd, 'USD', 'EUR')).toBe(usd)
  })
})

describe('tidyNames', () => {
  it('trims option type and option names but keeps ids', () => {
    const variants = addAxis(emptyVariants(), ' Color ', [' Red', 'Blue '], { price: 1 })
    const tidy = tidyNames(variants)
    expect(tidy.axes[0].name).toBe('Color')
    expect(tidy.axes[0].options).toEqual([{ id: 1, name: 'Red' }, { id: 2, name: 'Blue' }])
    expect(tidy.combinations).toBe(variants.combinations)
  })
})

describe('grid size', () => {
  it('counts the full grid and the combinations not offered', () => {
    expect(fullGridSize(emptyVariants())).toBe(0)
    const variants = grid()
    expect(fullGridSize(variants)).toBe(6)
    expect(missingCombinationCount(variants)).toBe(0)
    const fewer = removeCombination(removeCombination(variants, variants.combinations[0].id), variants.combinations[1].id)
    expect(missingCombinationCount(fewer)).toBe(2)
  })
})

describe('variantGrowthProblem', () => {
  it('accepts a table within the caps', () => {
    expect(variantGrowthProblem(grid())).toBeUndefined()
  })

  it('refuses more combinations than a product can offer', () => {
    const half = Array.from({ length: 16 }, (_, index) => `A${index}`)
    const big = addAxis(addAxis(emptyVariants(), 'One', half, { price: 1 }), 'Two', [...half, 'extra'], { price: 1 })
    expect(big.combinations.length).toBeGreaterThan(VARIANT_LIMITS.combinations)
    expect(variantGrowthProblem(big)).toContain(`at most ${VARIANT_LIMITS.combinations}`)
  })

  it('refuses more options than a product can have', () => {
    const names = Array.from({ length: VARIANT_LIMITS.options + 1 }, (_, index) => `O${index}`)
    expect(variantGrowthProblem(addAxis(emptyVariants(), 'Many', names, { price: 1 }))).toContain(`at most ${VARIANT_LIMITS.options} options`)
    // v1–v6 cap no option count.
    expect(variantGrowthProblem(addAxis(emptyVariants(), 'Many', names, { price: 1 }), true)).toBeUndefined()
  })
})

describe('defaultCombinationPrice', () => {
  it('prefers the typed base price, then the first combination, then 0', () => {
    expect(defaultCombinationPrice('4.50', 'USD', grid())).toBe(450)
    expect(defaultCombinationPrice('', 'USD', grid())).toBe(1000)
    expect(defaultCombinationPrice('abc', 'USD', grid())).toBe(1000)
    expect(defaultCombinationPrice('', 'USD', emptyVariants())).toBe(0)
  })
})
