import { describe, expect, it } from 'vitest'
import { itemZones, shipsToLabel, zoneCountriesLabel, zoneDeletionImpact, zoneDeletionMessage } from './item-zones'

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
})
