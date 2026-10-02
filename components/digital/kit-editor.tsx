'use client'

import { useId, useState } from 'react'
import { LockClosedIcon } from '@heroicons/react/24/outline'
import { DigitalAssetListEditor } from './asset-list-editor'
import { MAX_INSTRUCTIONS_LENGTH } from '@/lib/services/digital-delivery-plan'
import type { DeliverWhen, ItemDeliverablePayload } from '@/lib/types'

interface DigitalKitEditorProps {
  kit: ItemDeliverablePayload
  /** Receives an updater (like a state setter), so a long upload never undoes later edits. */
  onChange: (update: (kit: ItemDeliverablePayload) => ItemDeliverablePayload) => void
  identityId: string
  variantKeys?: string[]
  disabled?: boolean
}

const parseKeys = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

const TIMING_OPTIONS: Array<{ value: DeliverWhen; label: string; hint: string }> = [
  { value: 'payment_confirmed', label: 'After I confirm payment', hint: 'Ready to deliver once you mark the order Payment Received.' },
  { value: 'on_order', label: 'As soon as it is ordered', hint: 'For free downloads. Buyers write their own orders, including the amount, so this delivers whether or not anything was paid.' },
]

/**
 * What a digital product delivers: files and links, an optional pool of
 * license keys (one per unit sold), instructions for every buyer, and when
 * "Deliver ready orders" may send it. Saved encrypted to the seller's own key.
 */
export function DigitalKitEditor({ kit, onChange, identityId, variantKeys, disabled = false }: DigitalKitEditorProps) {
  const formId = useId()
  // Local text keeps blank lines while typing; the kit holds the parsed keys.
  const [keysText, setKeysText] = useState(kit.licenseKeys?.join('\n') ?? '')
  const sellsKeys = kit.licenseKeys !== undefined

  const toggleKeys = (enabled: boolean) => {
    const keys = parseKeys(keysText)
    onChange((current) => {
      const next = { ...current }
      if (enabled) next.licenseKeys = keys
      else delete next.licenseKeys
      return next
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 p-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-800 dark:text-green-200">
        <LockClosedIcon className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <span>Everything below is encrypted to your own key. Buyers only receive it when you deliver their order, encrypted to them.</span>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Files &amp; links</h3>
        <DigitalAssetListEditor
          assets={kit.assets}
          onChange={(update) => onChange((current) => ({ ...current, assets: update(current.assets) }))}
          identityId={identityId}
          variantKeys={variantKeys}
          disabled={disabled}
        />
      </section>

      <section className="space-y-2">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={sellsKeys}
            onChange={(e) => toggleKeys(e.target.checked)}
            disabled={disabled}
            className="w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
          />
          <span className="text-sm font-medium">Sell license keys (one per unit)</span>
        </label>
        {sellsKeys && (
          <>
            <textarea
              aria-label="License keys, one per line"
              value={keysText}
              onChange={(e) => {
                setKeysText(e.target.value)
                const keys = parseKeys(e.target.value)
                onChange((current) => ({ ...current, licenseKeys: keys }))
              }}
              placeholder={'One key per line\nXXXX-XXXX-XXXX\nYYYY-YYYY-YYYY'}
              rows={5}
              disabled={disabled}
              className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 font-mono text-sm"
            />
            <p className="text-xs text-gray-500">
              {kit.licenseKeys?.length ?? 0} key{kit.licenseKeys?.length === 1 ? '' : 's'} left. Each delivered unit takes the next key; when the pool runs out, orders wait until you add more.
            </p>
          </>
        )}
      </section>

      <section className="space-y-2">
        <label htmlFor={`${formId}-instructions`} className="block text-sm font-medium">Instructions for buyers</label>
        <textarea
          id={`${formId}-instructions`}
          value={kit.instructions ?? ''}
          onChange={(e) => {
            const instructions = e.target.value
            onChange((current) => {
              const next = { ...current }
              if (instructions) next.instructions = instructions
              else delete next.instructions
              return next
            })
          }}
          placeholder="How to redeem, install, or access what they bought"
          rows={3}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          disabled={disabled}
          className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none text-sm"
        />
      </section>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium mb-1">Delivery timing</legend>
        {TIMING_OPTIONS.map((option) => (
          <label key={option.value} className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name={`${formId}-timing`}
              value={option.value}
              checked={kit.deliverWhen === option.value}
              onChange={() => onChange((current) => ({ ...current, deliverWhen: option.value }))}
              disabled={disabled}
              className="mt-0.5 h-4 w-4 border-gray-300 text-yappr-500 focus:ring-yappr-500"
            />
            <span className="text-sm">
              <span className="font-medium">{option.label}</span>
              <span className="block text-xs text-gray-500">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  )
}
