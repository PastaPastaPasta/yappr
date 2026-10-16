/**
 * Per-item shipping zones (storefront v9, docs/STOREFRONT_V9.md): which of its
 * store's zones a listing ships under, as the editor, the store pages and the
 * CSV show it. Zones stay store-level; an item only names some of them. Ids an
 * item names that are not (or no longer) its store's zones are ignored.
 * Pure: no SDK, no topology import.
 */
import type { ShippingZone, StoreItem } from '@/lib/types'

type ZoneLike = Pick<ShippingZone, 'id' | 'name'>

/**
 * The store's zones `item` is limited to, in the store's order; null when it
 * names none and so ships under every zone. An empty list means it names only
 * zones the store no longer has, and ships nowhere.
 */
export function itemZones<Zone extends ZoneLike>(item: Pick<StoreItem, 'shippingZoneIds'>, zones: readonly Zone[]): Zone[] | null {
  if (!item.shippingZoneIds || item.shippingZoneIds.length === 0) return null
  const named = new Set(item.shippingZoneIds)
  return zones.filter((zone) => named.has(zone.id))
}

/** "Ships to: Domestic, Europe" for an item limited to zones; null for one that ships under every zone. */
export function shipsToLabel(item: Pick<StoreItem, 'shippingZoneIds' | 'fulfillment'>, zones: readonly ZoneLike[]): string | null {
  if (item.fulfillment === 'digital') return null
  const limited = itemZones(item, zones)
  if (!limited) return null
  return limited.length > 0 ? `Ships to: ${limited.map((zone) => zone.name).join(', ')}` : 'Not shipping anywhere at the moment'
}

/**
 * What deleting `zoneId` does to the listings: how many are limited to it,
 * and how many of those name no other zone of the store (so stop shipping).
 */
export function zoneDeletionImpact(zoneId: string, items: readonly Pick<StoreItem, 'shippingZoneIds' | 'fulfillment'>[], zones: readonly ZoneLike[]): { limited: number; stranded: number } {
  let limited = 0
  let stranded = 0
  for (const item of items) {
    if (item.fulfillment === 'digital' || !item.shippingZoneIds?.includes(zoneId)) continue
    limited += 1
    if ((itemZones(item, zones) ?? []).every((zone) => zone.id === zoneId)) stranded += 1
  }
  return { limited, stranded }
}

const products = (count: number) => `${count} product${count === 1 ? '' : 's'}`

/**
 * The delete-zone confirmation, warning about the listings limited to the
 * zone. `productsUnknown`: the listings could not be read, so the warning is
 * a general one.
 */
export function zoneDeletionMessage(impact: { limited: number; stranded: number }, { productsUnknown = false } = {}): string {
  const base = 'Are you sure you want to delete this shipping zone? This action cannot be undone.'
  if (productsUnknown) return `${base} Products limited to this zone may stop shipping.`
  if (impact.limited === 0) return base
  const limited = `${products(impact.limited)} ${impact.limited === 1 ? 'is' : 'are'} limited to this zone.`
  if (impact.stranded === 0) return `${base} ${limited} ${impact.limited === 1 ? 'It keeps shipping under its' : 'They keep shipping under their'} other zones.`
  const stranded = impact.stranded === impact.limited
    ? `${impact.limited === 1 ? 'It ships' : 'They ship'} under no other zone, so ${impact.limited === 1 ? 'it' : 'they'} will stop shipping until you choose other zones for ${impact.limited === 1 ? 'it' : 'them'}.`
    : `${impact.stranded} of them ${impact.stranded === 1 ? 'ships' : 'ship'} under no other zone and will stop shipping until you choose other zones.`
  return `${base} ${limited} ${stranded}`
}

/** A zone's countries for display: "US, CA", "US (IL)", or "All countries" when it names none. */
export function zoneCountriesLabel(zone: Pick<ShippingZone, 'countryPattern'>): string {
  if (!zone.countryPattern) return 'All countries'
  return zone.countryPattern
    .split('|')
    .map((part) => {
      const [country, suffix] = part.split('.')
      return suffix ? `${country.toUpperCase()} (${suffix.toUpperCase()})` : part.toUpperCase()
    })
    .join(', ')
}
