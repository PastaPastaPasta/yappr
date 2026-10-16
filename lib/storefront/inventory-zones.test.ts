import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreItem } from '@/lib/types'

/** The CSV export and import under `topology` (the cut is read when the modules load). */
async function under(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STOREFRONT_TOPOLOGY', topology)
  const csv = await import('./inventory-csv')
  const parser = await import('@/lib/upload/inventory-parser')
  const { variantsFromRows } = await import('./variant-codec')
  return { ...csv, ...parser, variantsFromRows }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const ZONES = [
  { id: 'zone-dom', name: 'Domestic' },
  { id: 'zone-eu', name: 'Europe, incl. UK' },
  { id: 'zone-row', name: 'Rest of World' },
]

function storeItem(fields: Partial<StoreItem> & Pick<StoreItem, 'id' | 'title'>): StoreItem {
  return { ownerId: 'owner', storeId: 'store', createdAt: new Date(0), status: 'active', currency: 'USD', basePrice: 500, ...fields }
}

const wallet = storeItem({ id: 'wallet', title: 'Leather Wallet', weight: 90, shippingZoneIds: ['zone-eu', 'zone-dom', 'zone-gone'] })
const mug = storeItem({ id: 'mug', title: 'Mug' })
const cap = (topology: Awaited<ReturnType<typeof under>>) => storeItem({
  id: 'cap', title: 'Cap', basePrice: undefined, shippingZoneIds: ['zone-row'],
  variants: topology.variantsFromRows(['Size'], [{ optionNames: ['M'], price: 500 }, { optionNames: ['L'], price: 600 }]).variants,
})

describe('Shipping Zones CSV column (storefront v9)', () => {
  it('exports the zone names after Weight, on every row of a product, leaving out ids that are not the store\'s', async () => {
    const v9 = await under('v9')
    const lines = v9.inventoryToCsv([wallet, mug, cap(v9)], 'USD', ZONES).csv.split('\n')
    const header = lines[0].split(',')
    expect(header.slice(10, 12)).toEqual(['Weight', 'Shipping Zones'])
    // In the store's zone order; the name with a comma is quoted.
    expect(lines[1]).toContain(',90,"Domestic; Europe, incl. UK",')
    // Blank: the mug ships under every zone.
    expect(lines[2].split(',').slice(1, 12)).toEqual(['Mug', '', '', '', '', '', '', '5.00', '', '', ''])
    expect(lines.filter((line) => line.startsWith('cap,'))).toHaveLength(2)
    for (const line of lines.filter((row) => row.startsWith('cap,'))) expect(line).toContain(',Rest of World,')
  })

  it('round-trips: an exported file parses back to the same zone ids', async () => {
    const v9 = await under('v9')
    const result = v9.parseInventoryCSV(v9.inventoryToCsv([wallet, mug, cap(v9)], 'USD', ZONES).csv, 'USD', ZONES)
    expect(result.errors).toEqual([])
    expect(result.items.flatMap((item) => [...item.errors, ...item.warnings])).toEqual([])
    expect(result.items.map((item) => v9.toStoreItemData(item).shippingZoneIds)).toEqual([['zone-dom', 'zone-eu'], undefined, ['zone-row']])
  })

  it('matches names ignoring case and spacing, accepts "|", and reads the column under its other names', async () => {
    const v9 = await under('v9')
    const [item] = v9.parseInventoryCSV('Title,Price,Ships To\nBelt,10.00, rest of world |DOMESTIC ; Domestic', 'USD', ZONES).items
    expect(item.errors).toEqual([])
    expect(item.shippingZoneIds).toEqual(['zone-row', 'zone-dom'])
    expect(v9.parseInventoryCSV('Title,Price,Zones\nBelt,10.00,Domestic', 'USD', ZONES).items[0].shippingZoneIds).toEqual(['zone-dom'])
  })

  it('refuses a product naming a zone the store does not have, and one naming more than 16', async () => {
    const v9 = await under('v9')
    const [unknown] = v9.parseInventoryCSV('Title,Price,Shipping Zones\nBelt,10.00,Domestic; Mars', 'USD', ZONES).items
    expect(unknown.errors).toEqual(['"Belt": there\'s no shipping zone named "Mars". Add it under Shipping Zones first, or fix the name.'])
    const many = Array.from({ length: 17 }, (_, index) => ({ id: `z${index}`, name: `Zone ${index}` }))
    const [tooMany] = v9.parseInventoryCSV(`Title,Price,Shipping Zones\nBelt,10.00,"${many.map((zone) => zone.name).join('; ')}"`, 'USD', many).items
    expect(tooMany.errors).toEqual(['"Belt": a product can be limited to at most 16 shipping zones (it lists 17).'])
  })

  it('takes a group\'s first non-empty cell, and warns when later rows disagree', async () => {
    const v9 = await under('v9')
    const csv = [
      'Group,Title,Price,Option1 Name,Option1 Value,Shipping Zones',
      'cap,Cap,5.00,Size,S,',
      'cap,Cap,5.00,Size,M,Domestic; Europe, incl. UK',
      'cap,Cap,5.00,Size,L,europe, incl. uk;domestic',
      'cap,Cap,5.00,Size,XL,Rest of World',
    ].join('\n').replace(/Domestic; Europe, incl\. UK/, '"Domestic; Europe, incl. UK"').replace(/europe, incl\. uk;domestic/, '"europe, incl. uk;domestic"')
    const [item] = v9.parseInventoryCSV(csv, 'USD', ZONES).items
    expect(item.errors).toEqual([])
    expect(item.shippingZoneIds).toEqual(['zone-dom', 'zone-eu'])
    expect(item.warnings).toEqual(['"Cap": its rows list different shipping zones, so the first row\'s were used.'])
  })

  it('reads a cell that is one zone\'s whole name as that zone, even with ";" or "|" in it', async () => {
    const v9 = await under('v9')
    const zones = [...ZONES, { id: 'zone-na', name: 'US; Canada' }]
    const result = v9.parseInventoryCSV(v9.inventoryToCsv([storeItem({ id: 'w', title: 'Wallet', shippingZoneIds: ['zone-na'] })], 'USD', zones).csv, 'USD', zones)
    expect(result.items.map((item) => [item.errors, item.shippingZoneIds])).toEqual([[[], ['zone-na']]])
  })

  it('reads names holding ";" or "|" against the store\'s zones, and only leftover text as unknown names', async () => {
    const v9 = await under('v9')
    const zones = [{ id: 'zone-na', name: 'US; Canada' }, { id: 'zone-eu', name: 'EU' }, { id: 'zone-us', name: 'US' }, { id: 'zone-pipe', name: 'A|B' }]
    const both = storeItem({ id: 'w', title: 'Wallet', shippingZoneIds: ['zone-na', 'zone-eu'] })
    const result = v9.parseInventoryCSV(v9.inventoryToCsv([both], 'USD', zones).csv, 'USD', zones)
    expect(result.items.map((item) => [item.errors, item.shippingZoneIds])).toEqual([[[], ['zone-na', 'zone-eu']]])
    const parsed = (cell: string) => v9.parseInventoryCSV(`Title,Price,Shipping Zones\nBelt,10.00,"${cell}"`, 'USD', zones).items[0]
    // The longest name that ends at a separator wins; "US" alone is still "US".
    expect(parsed('us; canada | US | a|b').shippingZoneIds).toEqual(['zone-na', 'zone-us', 'zone-pipe'])
    expect(parsed('US; Mars; EU').errors).toEqual(['"Belt": there\'s no shipping zone named "Mars". Add it under Shipping Zones first, or fix the name.'])
    expect(parsed('US; Mars; EU').shippingZoneIds).toEqual(['zone-us', 'zone-eu'])
    // "USA" is not "US" followed by more text.
    expect(parsed('USA').errors).toEqual(['"Belt": there\'s no shipping zone named "USA". Add it under Shipping Zones first, or fix the name.'])
  })

  it('refuses, rather than guesses, a cell that reads as more than one set of zones', async () => {
    const v9 = await under('v9')
    const zones = [{ id: 'zone-us', name: 'US' }, { id: 'zone-ca', name: 'Canada' }, { id: 'zone-both', name: 'US; Canada' }]
    const separate = storeItem({ id: 'w', title: 'Wallet', shippingZoneIds: ['zone-us', 'zone-ca'] })
    const combined = storeItem({ id: 'b', title: 'Belt', shippingZoneIds: ['zone-both'] })
    const exported = v9.inventoryToCsv([separate, combined, mug], 'USD', zones)
    // The export warns about both; the mug names no zones.
    expect(exported.zonesAmbiguous.map((item) => item.id)).toEqual(['w', 'b'])
    const result = v9.parseInventoryCSV(exported.csv, 'USD', zones)
    expect(result.items.map((item) => [item.errors, item.shippingZoneIds])).toEqual([
      [['"Wallet": the shipping zones "US; Canada" can be read more than one way (a zone name contains ";" or "|", or two zone names differ only in capitals). Rename that zone, then import again.'], undefined],
      [['"Belt": the shipping zones "US; Canada" can be read more than one way (a zone name contains ";" or "|", or two zone names differ only in capitals). Rename that zone, then import again.'], undefined],
      [[], undefined],
    ])
  })

  it('names that begin, end or consist of a separator: round-trip when unambiguous, refused when not', async () => {
    const v9 = await under('v9')
    /** An item limited to `limit`, exported with `zones` and read back: its errors, ids, and whether the export warned. */
    const roundTrip = (zones: { id: string; name: string }[], limit: string[]) => {
      const exported = v9.inventoryToCsv([storeItem({ id: 'w', title: 'Wallet', shippingZoneIds: limit })], 'USD', zones)
      const [item] = v9.parseInventoryCSV(exported.csv, 'USD', zones).items
      return { errors: item.errors.length, ids: item.shippingZoneIds, warned: exported.zonesAmbiguous.length > 0 }
    }
    const us = { id: 'zone-us', name: 'US' }
    // ";US" also reads as a blank part, then "US".
    expect(roundTrip([us, { id: 'zone-lead', name: ';US' }], ['zone-lead'])).toEqual({ errors: 1, ids: undefined, warned: true })
    expect(roundTrip([{ id: 'zone-lead', name: ';US' }], ['zone-lead'])).toEqual({ errors: 0, ids: ['zone-lead'], warned: false })
    // "US;" also reads as "US" and a trailing separator.
    expect(roundTrip([us, { id: 'zone-trail', name: 'US;' }], ['zone-trail'])).toEqual({ errors: 1, ids: undefined, warned: true })
    expect(roundTrip([{ id: 'zone-trail', name: 'US;' }], ['zone-trail'])).toEqual({ errors: 0, ids: ['zone-trail'], warned: false })
    // A zone named just ";" is that zone, never "no zones" (which would import unrestricted).
    expect(roundTrip([us, { id: 'zone-semi', name: ';' }], ['zone-semi'])).toEqual({ errors: 0, ids: ['zone-semi'], warned: false })
    // Beside another zone it exports "US; ;", which also reads as "US" and two stray separators.
    expect(roundTrip([us, { id: 'zone-semi', name: ';' }], ['zone-semi', 'zone-us'])).toEqual({ errors: 1, ids: undefined, warned: true })
  })

  it('refuses a cell that names no zone at all, rather than reading it as every zone', async () => {
    const v9 = await under('v9')
    const [item] = v9.parseInventoryCSV('Title,Price,Shipping Zones\nBelt,10.00,; |', 'USD', ZONES).items
    expect(item.shippingZoneIds).toBeUndefined()
    expect(item.errors).toEqual(['"Belt": the shipping zones "; |" name no zone. Write the zone names separated by ";", or leave the cell blank to ship under every zone.'])
  })

  it('round-trips a zone stored with surrounding spaces', async () => {
    const v9 = await under('v9')
    const zones = [{ id: 'zone-eu', name: '  Europe ' }, { id: 'zone-dom', name: 'Domestic' }]
    const item = storeItem({ id: 'w', title: 'Wallet', shippingZoneIds: ['zone-dom', 'zone-eu'] })
    const result = v9.parseInventoryCSV(v9.inventoryToCsv([item], 'USD', zones).csv, 'USD', zones)
    expect(result.items.map((parsed) => [parsed.errors, parsed.shippingZoneIds])).toEqual([[[], ['zone-eu', 'zone-dom']]])
  })

  it('holds only a file that has the column when the store\'s zones could not be read', async () => {
    const v9 = await under('v9')
    const withColumn = v9.parseInventoryCSV('Title,Price,Shipping Zones\nBelt,10.00,Domestic', 'USD', null)
    expect(withColumn.items).toEqual([])
    expect(withColumn.errors).toEqual([expect.objectContaining({ column: 'shippingZones', message: expect.stringMatching(/couldn't be loaded/) })])
    const without = v9.parseInventoryCSV('Title,Price\nBelt,10.00', 'USD', null)
    expect(without.errors).toEqual([])
    expect(without.items.map((item) => item.title)).toEqual(['Belt'])
  })

  it('reports the listings limited only to zones the store no longer has', async () => {
    const v9 = await under('v9')
    const orphan = storeItem({ id: 'o', title: 'Old Belt', shippingZoneIds: ['zone-gone'] })
    expect(v9.inventoryToCsv([wallet, mug, orphan], 'USD', ZONES).zonesGone.map((item) => item.id)).toEqual(['o'])
  })

  it('has the column in the template: one product with example zones, one with none', async () => {
    const v9 = await under('v9')
    const template = v9.inventoryCsvTemplate()
    expect(template.split('\n')[0]).toContain(',Weight,Shipping Zones,Option1 Name,')
    const result = v9.parseInventoryCSV(template, 'USD', [{ id: 'd', name: 'Domestic' }, { id: 'e', name: 'Europe' }])
    expect(result.errors).toEqual([])
    expect(result.items.map((item) => [item.errors, item.shippingZoneIds])).toEqual([[[], ['d', 'e']], [[], undefined]])
  })
})

describe('before storefront v9', () => {
  it('exports and templates no Shipping Zones column', async () => {
    const v8 = await under('v8')
    expect(v8.inventoryToCsv([wallet], 'USD', ZONES).csv).not.toMatch(/Shipping Zones|Domestic/)
    expect(v8.inventoryCsvTemplate()).not.toMatch(/Shipping Zones|Domestic/)
    // The header is exactly what it was before v9.
    expect(v8.inventoryToCsv([mug], 'USD').csv.split('\n')[0]).toBe('Group,Title,Description,Section,Category,Subcategory,Tags,SKU,Price,Quantity,Weight,Image URL')
  })

  it('ignores the column on import, with one file-level warning', async () => {
    const v8 = await under('v8')
    const result = v8.parseInventoryCSV('Title,Price,Shipping Zones\nBelt,10.00,Mars\nCap,5.00,Domestic', 'USD', ZONES)
    expect(result.items.map((item) => [item.errors, item.shippingZoneIds])).toEqual([[[], undefined], [[], undefined]])
    expect(result.warnings).toEqual([expect.objectContaining({ row: 1, column: 'shippingZones', message: expect.stringMatching(/Shipping Zones column was ignored/) })])
  })
})
