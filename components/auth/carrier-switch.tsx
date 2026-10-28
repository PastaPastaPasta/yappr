'use client'

import * as RadioGroup from '@radix-ui/react-radio-group'
import type { AppConnectCarrier } from 'platform-auth'
import { APP_CONNECT_CARRIER_LABELS, type AppConnectCarrierUris } from '@/lib/app-connect/carrier'

/**
 * Two-option switch for a build that offers both App Connect carriers
 * (testnet and devnet staging builds): the same sign-in request as a
 * `dash-key:` link for current wallets or as `dashpay://connect` for new ones.
 * Choosing changes only what the QR code and link show; the request is the same.
 */
export function CarrierSwitch({ uris, value, onChange }: {
  uris: AppConnectCarrierUris
  value: AppConnectCarrier
  onChange: (carrier: AppConnectCarrier) => void
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onChange(next as AppConnectCarrier)}
      orientation="horizontal"
      aria-label="Link format for your wallet"
      data-testid="app-connect-carrier-switch"
      className="grid w-full grid-flow-col auto-cols-fr gap-1 rounded-xl bg-gray-100 p-1 dark:bg-neutral-800"
    >
      {uris.map(({ carrier }) => {
        const label = APP_CONNECT_CARRIER_LABELS[carrier]
        return (
          <RadioGroup.Item
            key={carrier}
            value={carrier}
            data-testid={`app-connect-carrier-${carrier}`}
            className="flex flex-col items-center rounded-lg px-2 py-1.5 text-center transition-colors text-gray-600 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500 data-[state=checked]:bg-white data-[state=checked]:text-gray-900 data-[state=checked]:shadow-sm data-[state=checked]:ring-1 data-[state=checked]:ring-gray-300 dark:text-gray-400 dark:hover:text-gray-100 dark:data-[state=checked]:bg-neutral-700 dark:data-[state=checked]:text-white dark:data-[state=checked]:ring-neutral-500"
          >
            <span className="font-mono text-xs font-medium break-all">{label.name}</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">{label.audience}</span>
          </RadioGroup.Item>
        )
      })}
    </RadioGroup.Root>
  )
}
