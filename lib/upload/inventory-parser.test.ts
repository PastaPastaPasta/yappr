import { describe, expect, it } from 'vitest'
import { parseInventoryCSV, toStoreItemData } from './inventory-parser'

describe('inventory CSV currency units', () => {
  it.each([
    ['DASH', '1.25', 125000000],
    ['DASH', '0.00000001', 1],
    ['BTC', '0.12345678', 12345678],
    ['USD', '1.25', 125],
    ['EUR', '19.99', 1999],
  ])('imports %s %s in its smallest unit', (currency, price, expected) => {
    const result = parseInventoryCSV(`Item Name,Price,Quantity\nQA parcel,${price},2`, currency)
    expect(result.errors).toEqual([])
    expect(toStoreItemData(result.items[0])).toMatchObject({
      title: 'QA parcel', currency, basePrice: expected, stockQuantity: 2,
    })
  })

  it('preserves every variant price and derives the minimum in duffs', () => {
    const result = parseInventoryCSV(
      'Group,Item Name,Variant,Price,Quantity\nparcel,QA parcel,Small,0.12345678,2\nparcel,QA parcel,Large,1.25,0',
      'DASH',
    )
    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(1)
    expect(result.items[0].basePrice).toBe(12345678)
    expect(result.items[0].variants?.combinations.map(variant => variant.price)).toEqual([12345678, 125000000])
  })

  it.each(['Infinity', '1e100', '90071992.54740993'])('rejects an unsafe DASH amount %s', (price) => {
    const result = parseInventoryCSV(`Item Name,Price\nQA parcel,${price}`, 'DASH')
    expect(result.items).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].column).toBe('price')
  })
})

describe('merged tags fit storefront v4 (docs/SOCIAL_V9.md)', () => {
  it('keeps at most 32 tags of at most 64 characters and warns about the rest', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`).join(',')
    const long = 'x'.repeat(65)
    const result = parseInventoryCSV(`Item Name,Price,Tags\nParcel,1.00,"${many},${long}"`)
    const [item] = result.items
    expect(item.tags).toHaveLength(32)
    expect(item.tags).not.toContain(long)
    expect(result.warnings.map((w) => w.message).join(' ')).toMatch(/longer than 64 characters.*kept the first 32 of 40 tags/)
    expect(toStoreItemData(item).tags).toHaveLength(32)
  })
})
