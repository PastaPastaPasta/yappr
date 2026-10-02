'use client'

import { logger } from '@/lib/logger'
import { useCallback, useId, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { DigitalAssetListEditor } from '@/components/digital'
import { fulfillOrder, fulfillmentErrorText, KeyRecoveryError, loggableFulfillmentError, type FulfillOrderResult } from '@/lib/services/digital-fulfillment'
import { digitalLines, encodeDelivery, isDigitalOnly, MAX_DELIVERY_MESSAGE_LENGTH, planBlockers, planDelivery } from '@/lib/services/digital-delivery-plan'
import type { SellerKit } from '@/lib/services/item-deliverable-service'
import type { DigitalAsset, ItemDeliverablePayload, OrderPayload, StoreOrder } from '@/lib/types'

interface DeliverDigitalModalProps {
  isOpen: boolean
  onClose: () => void
  order: StoreOrder
  payload: OrderPayload
  kits: ReadonlyMap<string, SellerKit>
  sellerId: string
  sellerPrivateKey: Uint8Array
  /** True when this order already has a delivery: sending again reuses no license keys by default. */
  alreadyDelivered: boolean
  onDelivered: (result: FulfillOrderResult) => void
}

/**
 * Deliver an order's digital lines: each line's kit (files, links, license
 * keys, instructions), plus anything the seller attaches for this order only
 * and a message. The result is encrypted so only this order's buyer can read it.
 */
export function DeliverDigitalModal({
  isOpen,
  onClose,
  order,
  payload,
  kits,
  sellerId,
  sellerPrivateKey,
  alreadyDelivered,
  onDelivered,
}: DeliverDigitalModalProps) {
  const formId = useId()
  const [message, setMessage] = useState('')
  const [markDelivered, setMarkDelivered] = useState(isDigitalOnly(payload.items))
  const [includeNewKeys, setIncludeNewKeys] = useState(!alreadyDelivered)
  const [extras, setExtras] = useState<Record<string, DigitalAsset[]>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Lines with an attachment still uploading: its key is not in `extras` until it finishes.
  const [uploadingLines, setUploadingLines] = useState<ReadonlySet<string>>(new Set())
  const setLineUploading = useCallback((lineKey: string, busy: boolean) => {
    setUploadingLines((prev) => {
      if (prev.has(lineKey) === busy) return prev
      const next = new Set(prev)
      if (busy) next.add(lineKey)
      else next.delete(lineKey)
      return next
    })
  }, [])
  const isUploading = uploadingLines.size > 0

  const lines = useMemo(() => digitalLines(payload), [payload])

  const effectiveKits = useMemo(() => {
    const merged = new Map<string, ItemDeliverablePayload>()
    for (const itemId of new Set(lines.map((line) => line.itemId))) {
      const base = kits.get(itemId)?.kit
      const extra = extras[itemId] ?? []
      if (!base && extra.length === 0) continue
      const kit: ItemDeliverablePayload = base
        ? { ...base, assets: [...base.assets, ...extra] }
        : { v: 1, assets: extra, deliverWhen: 'payment_confirmed' }
      if (!includeNewKeys) delete kit.licenseKeys
      merged.set(itemId, kit)
    }
    return merged
  }, [lines, kits, extras, includeNewKeys])

  const plan = useMemo(() => planDelivery(payload, effectiveKits, message), [payload, effectiveKits, message])
  const sizeError = useMemo(() => {
    try {
      encodeDelivery(plan.delivery)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'This delivery is too large.'
    }
  }, [plan.delivery])
  const blockers = [
    ...planBlockers(plan),
    ...(sizeError ? [sizeError] : []),
  ]
  const orderSellsKeys = lines.some((line) => kits.get(line.itemId)?.kit.licenseKeys !== undefined)

  const handleClose = () => {
    if (isSubmitting) return
    onClose()
  }

  const handleSubmit = async () => {
    if (blockers.length > 0 || isSubmitting || isUploading) return
    setIsSubmitting(true)
    try {
      const result = await fulfillOrder({
        sellerId,
        order,
        delivery: plan.delivery,
        consumedKeys: plan.consumedKeys,
        kits,
        markDelivered,
        sellerPrivateKey,
      })
      toast.success('Delivered')
      for (const warning of result.warnings) toast.error(warning, { duration: 10_000 })
      onDelivered(result)
      onClose()
    } catch (error) {
      // Recovery details carry plaintext license keys: shown to the seller, never logged.
      logger.error('Digital delivery failed:', loggableFulfillmentError(error))
      toast.error(fulfillmentErrorText(error), { duration: error instanceof KeyRecoveryError ? Infinity : 8_000 })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && handleClose()} variant="sheet" className="max-w-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
        <Dialog.Title className="font-semibold text-gray-900 dark:text-gray-100">
          {alreadyDelivered ? 'Send again' : 'Deliver digital items'}
        </Dialog.Title>
        <IconButton aria-label="Close delivery" onClick={handleClose}>
          <XMarkIcon className="h-5 w-5" />
        </IconButton>
      </div>

      <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
        <Dialog.Description className="text-sm text-gray-500">
          Encrypted so only this buyer can read it. It appears in their orders and library.
        </Dialog.Description>

        {lines.map((line, index) => {
          // planDelivery omits an empty variantKey, so compare '' and absent as equal.
          const planned = plan.delivery.items.find((item) => item.itemId === line.itemId && (item.variantKey ?? '') === (line.variantKey ?? ''))
          return (
            <div key={`${line.itemId}-${line.variantKey ?? ''}-${index}`} className="p-3 border border-gray-200 dark:border-gray-800 rounded-lg space-y-2">
              <p className="text-sm font-medium">
                {line.itemTitle}
                {line.variantKey && <span className="text-gray-500 font-normal"> ({line.variantKey.replace(/\|/g, ' / ')})</span>}
                <span className="text-gray-500 font-normal"> ×{line.quantity}</span>
              </p>
              {planned ? (
                <p className="text-xs text-gray-500">
                  {planned.assets.length} file{planned.assets.length === 1 ? '' : 's'}/link{planned.assets.length === 1 ? '' : 's'}
                  {planned.licenseKeys ? ` · ${planned.licenseKeys.length} license key${planned.licenseKeys.length === 1 ? '' : 's'}` : ''}
                  {planned.instructions ? ' · instructions' : ''}
                </p>
              ) : (
                <p className="text-xs text-yellow-700 dark:text-yellow-300">No delivery content saved for this product.</p>
              )}
              <details>
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                  Attach files or links for this order only
                </summary>
                <div className="mt-2">
                  <DigitalAssetListEditor
                    assets={extras[line.itemId] ?? []}
                    onChange={(update) => setExtras((prev) => ({ ...prev, [line.itemId]: update(prev[line.itemId] ?? []) }))}
                    onBusyChange={(busy) => setLineUploading(`${line.itemId}-${line.variantKey ?? ''}-${index}`, busy)}
                    identityId={sellerId}
                    disabled={isSubmitting}
                  />
                </div>
              </details>
            </div>
          )
        })}

        {alreadyDelivered && orderSellsKeys && (
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeNewKeys}
              onChange={(e) => setIncludeNewKeys(e.target.checked)}
              disabled={isSubmitting}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
            />
            <span className="text-sm">
              Issue new license keys
              <span className="block text-xs text-gray-500">The keys from the earlier delivery stay in the buyer&apos;s library either way.</span>
            </span>
          </label>
        )}

        <div>
          <label htmlFor={`${formId}-message`} className="block text-sm font-medium mb-1">Message to buyer <span className="text-gray-400">(optional)</span></label>
          <textarea
            id={`${formId}-message`}
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, MAX_DELIVERY_MESSAGE_LENGTH))}
            rows={2}
            disabled={isSubmitting}
            placeholder="Thanks for your purchase!"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent resize-none focus:outline-none focus:ring-2 focus:ring-yappr-500 text-sm"
          />
        </div>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={markDelivered}
            onChange={(e) => setMarkDelivered(e.target.checked)}
            disabled={isSubmitting}
            className="w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
          />
          <span className="text-sm">Also mark the order Delivered</span>
        </label>

        {blockers.length > 0 && (
          <div role="alert" className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg space-y-1">
            {blockers.map((blocker, index) => (
              <p key={index} className="flex items-start gap-2 text-sm text-yellow-800 dark:text-yellow-200">
                <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                {blocker}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
        <Button variant="ghost" onClick={handleClose} disabled={isSubmitting}>Cancel</Button>
        <Button onClick={() => { handleSubmit().catch((error) => logger.error(error)) }} disabled={blockers.length > 0 || isSubmitting || isUploading}>
          {isSubmitting ? 'Delivering…' : isUploading ? 'Uploading…' : 'Deliver'}
        </Button>
      </div>
    </Modal>
  )
}
