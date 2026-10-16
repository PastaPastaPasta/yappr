/**
 * Per-item shipping zones (storefront v9, docs/STOREFRONT_V9.md): which of its
 * store's zones a listing ships under, as the editor, the store pages and the
 * CSV show it. Zones stay store-level; an item only names some of them. Ids an
 * item names that are not (or no longer) its store's zones are ignored.
 * Pure: no SDK, no topology import.
 */
import type { ShippingZone, StoreItem } from '@/lib/types'

type ZoneLike = Pick<ShippingZone, 'id' | 'name'>

/** The item editor's choice: every zone of the store, or only the ticked ones. */
export type ItemZoneMode = 'all' | 'only'

/**
 * What an item save does with `shippingZoneIds`: `keep` (the key is left out,
 * so the stored value stays, stale ids included), `set` (`[]` = every zone),
 * or `noneChosen` ("only these zones" with none ticked, which is refused). An
 * edit writes the zones only when the seller touched the controls, so a save
 * never quietly rewrites a limit it could not show (no zones, or unreadable
 * ones); a create writes the choice.
 */
export type ZoneUpdate = { kind: 'keep' } | { kind: 'set'; ids: string[] } | { kind: 'noneChosen' }

export function zoneUpdateFor(mode: ItemZoneMode, selection: readonly string[], { touched, editing }: { touched: boolean; editing: boolean }): ZoneUpdate {
  if (editing && !touched) return { kind: 'keep' }
  if (mode === 'all') return { kind: 'set', ids: [] }
  return selection.length > 0 ? { kind: 'set', ids: [...selection] } : { kind: 'noneChosen' }
}

/** Whether a stored limit names none of the store's current zones (`zones`: null while unknown). */
export function zonesStranded(storedIds: readonly string[], zones: readonly ZoneLike[] | null): boolean {
  return storedIds.length > 0 && zones !== null && !storedIds.some((id) => zones.some((zone) => zone.id === id))
}

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

// ---- the inventory CSV's Shipping Zones cell ---------------------------------------

/** Between zone names in one cell: names may hold commas, so not a comma. */
export const ZONE_SEPARATOR = '; '

/** The zone named `name` (trimmed on both sides): exactly, else ignoring case. */
function zoneNamed<Zone extends ZoneLike>(zones: readonly Zone[], name: string): Zone | undefined {
  const wanted = name.trim()
  if (wanted === '') return undefined
  return zones.find((zone) => zone.name.trim() === wanted) ?? zones.find((zone) => zone.name.trim().toLowerCase() === wanted.toLowerCase())
}

/** Whether `text` has nothing from `end` on but spaces up to a separator (";" or "|") or its end. */
const atZoneBoundary = (text: string, end: number) => /^\s*(?:[;|]|$)/.test(text.slice(end))

/**
 * A cell no complete reading accounts for, read for its error: at each
 * position the longest store name that runs up to a separator or the cell's
 * end (exactly, else ignoring case; names trimmed) is taken, and only text no
 * name accounts for is split on the separators, as unknown names.
 */
function greedyZoneCell<Zone extends ZoneLike>(cell: string, zones: readonly Zone[]): { found: Zone[]; unknown: string[] } {
  const names = zones
    .map((zone) => ({ zone, name: zone.name.trim() }))
    .filter(({ name }) => name !== '')
    .sort((a, b) => b.name.length - a.name.length)
  const found: Zone[] = []
  const unknown: string[] = []
  let at = 0
  while (at < cell.length) {
    const lead = /^[\s;|]*/.exec(cell.slice(at))?.[0].length ?? 0
    at += lead
    if (at >= cell.length) break
    const text = cell.slice(at)
    const matching = (same: (a: string, b: string) => boolean) =>
      names.find(({ name }) => same(text.slice(0, name.length), name) && atZoneBoundary(text, name.length))
    const hit = matching((a, b) => a === b) ?? matching((a, b) => a.toLowerCase() === b.toLowerCase())
    if (hit) {
      found.push(hit.zone)
      at += hit.name.length
      continue
    }
    const separator = text.search(/[;|]/)
    const token = (separator < 0 ? text : text.slice(0, separator)).trim()
    if (token) unknown.push(token)
    at += separator < 0 ? text.length : separator
  }
  return { found, unknown }
}

/**
 * Up to 3 distinct ways to read `parts`, from `from` on, as consecutive zone
 * names: a name is one or more consecutive parts re-joined with their own
 * separators. A blank part is either a doubled or trailing separator (skipped)
 * or the start of a name that itself begins with one (";US"), and both are
 * tried. Only the all-skipped reading is empty, and there is at most one per
 * position, so 3 keeps any two non-empty readings there are.
 */
function zoneReadings<Zone extends ZoneLike>(parts: readonly string[], separators: readonly string[], zones: readonly Zone[], from: number, memo = new Map<number, Zone[][]>()): Zone[][] {
  if (from >= parts.length) return [[]]
  const known = memo.get(from)
  if (known) return known
  const readings: Zone[][] = []
  const seen = new Set<string>()
  const add = (reading: Zone[]) => {
    const key = reading.map((zone) => zone.id).join('\n')
    if (readings.length < 3 && !seen.has(key)) {
      seen.add(key)
      readings.push(reading)
    }
  }
  if (parts[from].trim() === '') for (const rest of zoneReadings(parts, separators, zones, from + 1, memo)) add(rest)
  let name = ''
  for (let to = from; to < parts.length && readings.length < 3; to++) {
    name += (to > from ? separators[to - 1] : '') + parts[to]
    const zone = zoneNamed(zones, name)
    if (!zone) continue
    for (const rest of zoneReadings(parts, separators, zones, to + 1, memo)) add([zone, ...rest])
  }
  memo.set(from, readings)
  return readings
}

/**
 * The store zones a `Shipping Zones` cell names. Names are separated by ";"
 * (the export's) or "|", but an older zone's own name may hold either, so the
 * cell is split into parts and every way to group consecutive parts into
 * zone names is tried. One complete reading is the answer; more than one is
 * `ambiguous` (zones "US", "Canada" and "US; Canada" make "US; Canada" read
 * two ways), which an import refuses rather than guess; none reports the
 * names no zone has as `unknown`.
 */
export function readZoneCell<Zone extends ZoneLike>(cell: string, zones: readonly Zone[]): { found: Zone[]; unknown: string[]; ambiguous: boolean } {
  const pieces = cell.split(/([;|])/)
  const parts = pieces.filter((_, index) => index % 2 === 0)
  const separators = pieces.filter((_, index) => index % 2 === 1)
  // A reading of no zones (a cell of only separators) says nothing: it never stands for "every zone".
  const readings = zoneReadings(parts, separators, zones, 0).filter((reading) => reading.length > 0)
  if (readings.length === 1) return { found: readings[0], unknown: [], ambiguous: false }
  if (readings.length > 1) return { found: [], unknown: [], ambiguous: true }
  return { ...greedyZoneCell(cell, zones), ambiguous: false }
}
