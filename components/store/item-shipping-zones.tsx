'use client'

import Link from 'next/link'
import { useId } from 'react'
import { TruckIcon } from '@heroicons/react/24/outline'
import { Spinner } from '@/components/ui/spinner'
import { zoneCountriesLabel } from '@/lib/storefront/item-zones'
import type { ShippingZone } from '@/lib/types'

export type ItemZoneMode = 'all' | 'only'

interface ItemShippingZonesProps {
  /** The store's zones; null while loading. */
  zones: ShippingZone[] | null
  loadFailed: boolean
  mode: ItemZoneMode
  onModeChange: (mode: ItemZoneMode) => void
  selected: readonly string[]
  onSelectedChange: (ids: string[]) => void
  /** Where the seller manages the store's zones. */
  manageHref: string
  /** An existing product (its stored zones are kept when the store's cannot be read). */
  editing: boolean
  disabled?: boolean
}

/**
 * Which of its store's shipping zones a shipped product ships under
 * (storefront v9, docs/STOREFRONT_V9.md): all of them (nothing is stored), or
 * only the ones ticked.
 */
export function ItemShippingZones({ zones, loadFailed, mode, onModeChange, selected, onSelectedChange, manageHref, editing, disabled }: ItemShippingZonesProps) {
  const formId = useId()
  const toggle = (id: string, checked: boolean) => {
    onSelectedChange(checked ? [...selected, id] : selected.filter((selectedId) => selectedId !== id))
  }

  return (
    <fieldset className="border-t border-gray-200 dark:border-gray-800 pt-6">
      <legend className="font-medium flex items-center gap-2 mb-2">
        <TruckIcon className="h-5 w-5 text-yappr-500" aria-hidden="true" />
        Shipping zones
      </legend>
      {loadFailed ? (
        <p role="alert" className="text-sm text-red-600">
          {editing
            ? <>Could not load your shipping zones. Saving leaves this product&apos;s zones as they are. Reload the page to try again.</>
            : <>Could not load your shipping zones, so this product will ship under all of them. Reload the page to choose.</>}
        </p>
      ) : zones === null ? (
        <Spinner size="sm" />
      ) : zones.length === 0 ? (
        <p className="text-sm text-gray-500">
          Your store has no shipping zones yet, so buyers check out without a shipping charge.{' '}
          <Link href={manageHref} className="text-yappr-500 hover:underline">Add zones to your store</Link> to choose where this product ships.
        </p>
      ) : (
        <div className="space-y-2">
          {([
            { value: 'all', label: "All of the store's shipping zones" },
            { value: 'only', label: 'Only these zones' },
          ] as const).map(({ value, label }) => (
            <label key={value} className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name={`${formId}-zone-mode`}
                value={value}
                checked={mode === value}
                onChange={() => onModeChange(value)}
                disabled={disabled}
                className="w-4 h-4 border-gray-300 text-yappr-500 focus:ring-yappr-500"
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
          {mode === 'only' && (
            <div className="ml-7 space-y-2">
              {zones.map((zone) => (
                <label key={zone.id} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(zone.id)}
                    onChange={(e) => toggle(zone.id, e.target.checked)}
                    disabled={disabled}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
                  />
                  <span>
                    <span className="block text-sm font-medium">{zone.name}</span>
                    <span className="block text-xs text-gray-500">{zoneCountriesLabel(zone)}</span>
                  </span>
                </label>
              ))}
              {selected.length === 0 && <p className="text-xs text-gray-500">Choose at least one zone.</p>}
            </div>
          )}
        </div>
      )}
    </fieldset>
  )
}
