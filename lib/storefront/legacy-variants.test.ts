import { describe, expect, it } from 'vitest'
import { decodeLegacyVariants, encodeLegacyVariants } from './legacy-variants'

/** `value`, failing the test when it is missing. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

const IMAGES = ['https://a/hero.png', 'https://a/blue.png']
const legacy = JSON.stringify({
  axes: [{ name: 'Color', options: ['Red', 'Blue'] }, { name: 'Size', options: ['S', 'L'] }],
  combinations: [
    { key: 'Red|S', price: 100, stock: 3, sku: 'R-S' },
    { key: 'Blue|L', price: 120, imageUrl: 'https://a/blue.png' },
    { key: 'Red|XL', price: 1 },
    { key: 'Red|S', price: 2 },
    { key: 'Blue|S', price: -1 },
  ],
})

describe('the v1–v6 variants JSON', () => {
  it('reads as the v7 model, numbering options in order and dropping bad combinations', () => {
    const table = decodeLegacyVariants(legacy, IMAGES)
    expect(table?.axes).toEqual([{ name: 'Color', options: [{ id: 1, name: 'Red' }, { id: 2, name: 'Blue' }] }, { name: 'Size', options: [{ id: 3, name: 'S' }, { id: 4, name: 'L' }] }])
    expect(table?.combinations).toEqual([
      { id: '1.3', optionIds: [1, 3], price: 100, stock: 3, sku: 'R-S' },
      { id: '2.4', optionIds: [2, 4], price: 120, image: 2 },
    ])
    expect(table?.nextOptionId).toBe(5)
  })

  it('writes back the same JSON it read', () => {
    const json = JSON.stringify({ axes: [{ name: 'Size', options: ['S', 'M'] }], combinations: [{ key: 'S', price: 1000, stock: 2 }, { key: 'M', price: 1500, imageUrl: 'https://a/blue.png' }] })
    expect(encodeLegacyVariants(defined(decodeLegacyVariants(json, IMAGES)), IMAGES)).toBe(json)
  })

  it('reads nothing from a missing or broken value', () => {
    for (const value of [undefined, '', 'not json', '{"axes":[]}', '{"axes":[{"name":"S","options":[]}],"combinations":[]}', '{"axes":[{"name":"S","options":["a"]}],"combinations":[{"key":"b","price":1}]}']) {
      expect(decodeLegacyVariants(value)).toBeUndefined()
    }
  })
})
