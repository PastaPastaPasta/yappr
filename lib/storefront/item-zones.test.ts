import { describe, expect, it } from 'vitest'
import { itemZones, shipsToLabel, zoneCountriesLabel, zoneDeletionImpact, zoneDeletionMessage, readZoneCell, zoneUpdateFor, zonesStranded } from './item-zones'

const zones = [{ id: 'us', name: 'Domestic' }, { id: 'eu', name: 'Europe' }, { id: 'row', name: 'Rest of World' }]

describe('per-item shipping zones', () => {
  it('names the store zones an item is limited to, in the store order, ignoring foreign ids', () => {
    expect(itemZones({}, zones)).toBeNull()
    expect(itemZones({ shippingZoneIds: [] }, zones)).toBeNull()
    expect(itemZones({ shippingZoneIds: ['eu', 'gone', 'us'] }, zones)?.map((zone) => zone.id)).toEqual(['us', 'eu'])
    expect(itemZones({ shippingZoneIds: ['gone'] }, zones)).toEqual([])
  })

  it('labels where an item ships, only when it is limited and shipped', () => {
    expect(shipsToLabel({}, zones)).toBeNull()
    expect(shipsToLabel({ shippingZoneIds: ['eu', 'us'] }, zones)).toBe('Ships to: Domestic, Europe')
    expect(shipsToLabel({ shippingZoneIds: ['gone'] }, zones)).toBe('Not shipping anywhere at the moment')
    expect(shipsToLabel({ shippingZoneIds: ['eu'], fulfillment: 'digital' }, zones)).toBeNull()
  })

  it('counts the listings a zone deletion limits and strands', () => {
    const items = [
      { shippingZoneIds: ['eu'] },
      { shippingZoneIds: ['eu', 'gone'] },
      { shippingZoneIds: ['eu', 'us'] },
      { shippingZoneIds: ['us'] },
      {},
    ]
    expect(zoneDeletionImpact('eu', items, zones)).toEqual({ limited: 3, stranded: 2 })
    expect(zoneDeletionImpact('row', items, zones)).toEqual({ limited: 0, stranded: 0 })
  })

  it('warns in the delete confirmation', () => {
    expect(zoneDeletionMessage({ limited: 0, stranded: 0 })).not.toMatch(/limited/)
    expect(zoneDeletionMessage({ limited: 0, stranded: 0 }, { productsUnknown: true })).toMatch(/cannot be undone\. Products limited to this zone may stop shipping\.$/)
    expect(zoneDeletionMessage({ limited: 2, stranded: 0 })).toMatch(/2 products are limited to this zone\. They keep shipping under their other zones/)
    expect(zoneDeletionMessage({ limited: 1, stranded: 0 })).toMatch(/1 product is limited to this zone\. It keeps shipping under its other zones/)
    expect(zoneDeletionMessage({ limited: 1, stranded: 1 })).toMatch(/1 product is limited to this zone\. It ships under no other zone, so it will stop shipping/)
    expect(zoneDeletionMessage({ limited: 3, stranded: 1 })).toMatch(/3 products are limited to this zone\. 1 of them ships under no other zone/)
  })

  it('shows a zone\'s countries', () => {
    expect(zoneCountriesLabel({})).toBe('All countries')
    expect(zoneCountriesLabel({ countryPattern: 'US|ca' })).toBe('US, CA')
    expect(zoneCountriesLabel({ countryPattern: 'US.IL|US.6' })).toBe('US (IL), US (6)')
  })

  it('an edit writes the zones only when the seller touched the controls; a create writes the choice', () => {
    // A stranded limit (no zones, or unreadable ones) shown as "only" with nothing ticked is kept, not cleared.
    expect(zoneUpdateFor('only', [], { touched: false, editing: true })).toEqual({ kind: 'keep' })
    expect(zoneUpdateFor('all', [], { touched: false, editing: true })).toEqual({ kind: 'keep' })
    // "Ship it under every zone" counts as a change.
    expect(zoneUpdateFor('all', ['us'], { touched: true, editing: true })).toEqual({ kind: 'set', ids: [] })
    expect(zoneUpdateFor('only', ['us', 'eu'], { touched: true, editing: true })).toEqual({ kind: 'set', ids: ['us', 'eu'] })
    expect(zoneUpdateFor('only', [], { touched: true, editing: true })).toEqual({ kind: 'noneChosen' })
    expect(zoneUpdateFor('all', [], { touched: false, editing: false })).toEqual({ kind: 'set', ids: [] })
    expect(zoneUpdateFor('only', ['us'], { touched: true, editing: false })).toEqual({ kind: 'set', ids: ['us'] })
  })

  it('sees a stored limit that names none of the current zones', () => {
    expect(zonesStranded(['gone'], zones)).toBe(true)
    expect(zonesStranded(['gone'], [])).toBe(true)
    expect(zonesStranded(['gone', 'eu'], zones)).toBe(false)
    expect(zonesStranded([], zones)).toBe(false)
    expect(zonesStranded(['gone'], null)).toBe(false)
  })

  it('reads a Shipping Zones cell into zones: one reading, several, or none', () => {
    const store = [{ id: 'us', name: 'US' }, { id: 'ca', name: 'Canada' }, { id: 'na', name: ' US; Canada ' }, { id: 'eu', name: 'EU' }]
    const ids = (cell: string, zones = store) => {
      const read = readZoneCell(cell, zones)
      return { ids: read.found.map((zone) => zone.id), unknown: read.unknown, ambiguous: read.ambiguous }
    }
    expect(ids('US; Canada')).toEqual({ ids: [], unknown: [], ambiguous: true })
    expect(ids('us | eu;')).toEqual({ ids: ['us', 'eu'], unknown: [], ambiguous: false })
    // Without the separate zones the combined name is the only reading.
    expect(ids('US; Canada; EU', store.slice(2))).toEqual({ ids: ['na', 'eu'], unknown: [], ambiguous: false })
    expect(ids('US; Mars')).toEqual({ ids: ['us'], unknown: ['Mars'], ambiguous: false })
    // Many parts stay quick: the readings are memoized and capped at two.
    expect(ids(Array.from({ length: 40 }, () => 'US').join(';') + ';Mars').unknown).toEqual(['Mars'])
  })

  it('refuses a name that matches two zones once case is ignored, but keeps an exact match', () => {
    // Zone names are unique per store, not case-insensitively.
    const store = [{ id: 'd1', name: 'Domestic' }, { id: 'd2', name: 'DOMESTIC' }, { id: 'eu', name: 'EU' }]
    const read = (cell: string) => {
      const result = readZoneCell(cell, store)
      return { ids: result.found.map((zone) => zone.id), ambiguous: result.ambiguous }
    }
    expect(read('domestic')).toEqual({ ids: [], ambiguous: true })
    expect(read('eu; domestic')).toEqual({ ids: [], ambiguous: true })
    expect(read('DOMESTIC')).toEqual({ ids: ['d2'], ambiguous: false })
    expect(read('Domestic; eu')).toEqual({ ids: ['d1', 'eu'], ambiguous: false })
  })
})
