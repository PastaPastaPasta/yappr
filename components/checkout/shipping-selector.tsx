'use client'

import { TruckIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { formatPrice } from '@/lib/utils/format'
import type { ShippingZone } from '@/lib/types'

interface ShippingSelectorProps {
  matchedZone: ShippingZone | null
  shippingCost: number
  currency: string
  city: string
  country: string
  zonesLoadFailed: boolean
  hasNoZones: boolean
  onSubmit: () => void
}

export function ShippingSelector({
  matchedZone,
  shippingCost,
  currency,
  city,
  country,
  zonesLoadFailed,
  hasNoZones,
  onSubmit
}: ShippingSelectorProps) {
  const canProceed = matchedZone || zonesLoadFailed || hasNoZones

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 text-lg font-medium">
        <TruckIcon className="h-5 w-5 text-yappr-500" />
        Shipping Method
      </div>

      {matchedZone ? (
        <div className="p-4 border border-yappr-500 bg-yappr-50 dark:bg-yappr-900/20 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">{matchedZone.name}</p>
              <p className="text-sm text-gray-500">
                Shipping to {city}, {country}
              </p>
            </div>
            <p className="font-bold text-lg">{formatPrice(shippingCost, currency)}</p>
          </div>
        </div>
      ) : zonesLoadFailed || hasNoZones ? (
        <div className="p-4 border border-blue-200 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-blue-700 dark:text-blue-300">
          <p className="font-medium">Shipping calculated separately</p>
          <p className="text-sm mt-1">
            {hasNoZones
              ? 'The seller has not configured shipping zones. They will contact you about shipping costs.'
              : 'Shipping information is temporarily unavailable. The seller will contact you about shipping.'}
          </p>
        </div>
      ) : (
        <div className="p-4 border border-red-200 bg-red-50 dark:bg-red-900/20 rounded-lg text-red-700 dark:text-red-300">
          <p>We cannot ship to this address. The seller does not ship to your region.</p>
        </div>
      )}

      <Button
        className="w-full"
        onClick={onSubmit}
        disabled={!canProceed}
      >
        Continue to Payment
      </Button>
    </div>
  )
}
