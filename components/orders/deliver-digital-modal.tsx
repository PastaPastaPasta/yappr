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
import { digitalLines, isDigitalOnly, lineProblems, MAX_DELIVERY_MESSAGE_LENGTH, planBlockers, planDelivery, type ItemListing } from '@/lib/services/digital-delivery-plan'
import type { SellerKit } from '@/lib/services/item-deliverable-service'
import type { DigitalAsset, ItemDeliverablePayload, OrderDelivery, OrderItem, OrderPayload, StoreOrder } from '@/lib/types'

interface DeliverDigitalModalProps {
  isOpen: boolean
  onClose: () => void
  order: StoreOrder
  payload: OrderPayload
  kits: ReadonlyMap<string, SellerKit>
  /** The seller's own listing of each item the order names: the lines are buyer-written. */
  listings: ReadonlyMap<string, ItemListing>
  sellerId: string
  sellerPrivateKey: Uint8Array
  /** True when this order already has a delivery: sending again takes no new unique codes by default. */
  alreadyDelivered: boolean
  /** The order's earlier deliveries (decrypted where possible): which lines they covered. */
  previousDeliveries: readonly OrderDelivery[]
  onDelivered: (result: FulfillOrderResult) => void
  /** A failed delivery may still have rewritten pools (see FulfillmentError). */
  onFailed: (error: unknown) => void
}

/**
 * Deliver an order's digital lines: each line's kit (links, codes, files,
 * unique codes, instructions), plus anything the seller adds for this order only
 * and a message. The result is encrypted so only this order's buyer can read it.
 */
export function DeliverDigitalModal({
  isOpen,
  onClose,
  order,
  payload,
  kits,
  listings,
  sellerId,
  sellerPrivateKey,
  alreadyDelivered,
  previousDeliveries,
  onDelivered,
  onFailed,
}: DeliverDigitalModalProps) {
  const formId = useId()
  const lines = useMemo(() => digitalLines(payload), [payload])
  // What earlier deliveries covered, per line (same item and variant), two ways:
  // - `possiblySent`: any receipt that may hold it, pending ones and ones this
  //   device cannot read included. Such a line takes no new unique codes
  //   unless the seller asks, so a code is never sent twice by default.
  // - `confirmedSent`: a confirmed receipt this device read that holds it.
  //   Only this counts towards marking the order Delivered.
  const { possiblySent, confirmedSent } = useMemo(() => {
    const covers = (delivery: OrderDelivery, line: OrderItem) =>
      delivery.payload?.items.some((item) => item.itemId === line.itemId && (item.variantKey ?? '') === (line.variantKey ?? '')) ?? false
    const unreadable = previousDeliveries.some((delivery) => !delivery.payload)
    return {
      possiblySent: lines.map((line) => unreadable || previousDeliveries.some((delivery) => covers(delivery, line))),
      confirmedSent: lines.map((line) => previousDeliveries.some((delivery) => !delivery.unconfirmed && covers(delivery, line))),
    }
  }, [lines, previousDeliveries])
  // The lines this delivery covers. A delivery too large for one receipt goes
  // out in parts: untick some lines, deliver, then deliver the rest.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => {
    const pending = lines.flatMap((_, index) => (possiblySent[index] ? [] : [index]))
    return new Set(pending.length > 0 ? pending : lines.map((_, index) => index))
  })
  const [message, setMessage] = useState('')
  const [markDelivered, setMarkDelivered] = useState(isDigitalOnly(payload.items))
  // Applies only to lines that may have gone out before; an unsent line always takes its codes.
  const [includeNewKeys, setIncludeNewKeys] = useState(false)
  const [extras, setExtras] = useState<Record<string, DigitalAsset[]>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  // The seller has checked lines that disagree with their listings (title, variant, price).
  const [reviewed, setReviewed] = useState(false)
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

  const selectedLines = useMemo(() => lines.filter((_, index) => selected.has(index)), [lines, selected])
  // Every digital line is in this delivery or an earlier one: only then is the order complete.
  const completesOrder = lines.every((_, index) => selected.has(index) || confirmedSent[index])
  const toggleLine = (index: number) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  })

  const effectiveKits = useMemo(() => {
    const merged = new Map<string, ItemDeliverablePayload>()
    for (const itemId of new Set(selectedLines.map((line) => line.itemId))) {
      const base = kits.get(itemId)?.kit
      const extra = extras[itemId] ?? []
      if (!base && extra.length === 0) continue
      const kit: ItemDeliverablePayload = base
        ? { ...base, assets: [...base.assets, ...extra] }
        : { v: 1, assets: extra, deliverWhen: 'payment_confirmed' }
      merged.set(itemId, kit)
    }
    return merged
  }, [selectedLines, kits, extras])

  // The order with only the chosen digital lines (its other lines, malformed ones included, kept).
  const selectedPayload = useMemo(() => {
    const unchosen = new Set(lines.filter((_, index) => !selected.has(index)))
    return { ...payload, items: payload.items.filter((item) => !unchosen.has(item)) }
  }, [payload, lines, selected])
  // Lines that may have gone out before take new codes only if the seller asks.
  const resentWithoutKeys = useMemo(() => {
    const resent = new Set(lines.filter((_, index) => possiblySent[index]))
    return (line: OrderItem) => !includeNewKeys && resent.has(line)
  }, [lines, possiblySent, includeNewKeys])
  const plan = useMemo(() => planDelivery(selectedPayload, effectiveKits, message, resentWithoutKeys), [selectedPayload, effectiveKits, message, resentWithoutKeys])
  // The buyer wrote these lines: the kit sent is chosen by itemId, whatever title or price they claim.
  const problems = useMemo(() => lineProblems(selectedPayload, order.storeId, listings), [selectedPayload, order.storeId, listings])
  const blockers = useMemo(() => [
    ...(selectedLines.length === 0 ? ['Choose at least one item to deliver.'] : []),
    ...problems.filter((problem) => problem.blocking).map((problem) => problem.text),
    ...planBlockers(plan),
  ], [selectedLines, problems, plan])
  const warnings = problems.filter((problem) => !problem.blocking)
  const needsReview = warnings.length > 0 && !reviewed
  // Re-sending a line whose codes may already have gone out: new codes only if the seller asks.
  const sendsAgain = lines.some((_, index) => selected.has(index) && possiblySent[index])
  const resendSellsKeys = lines.some((line, index) => selected.has(index) && possiblySent[index] && kits.get(line.itemId)?.kit.licenseKeys !== undefined)

  const handleClose = () => {
    if (isSubmitting) return
    onClose()
  }

  const handleSubmit = async () => {
    if (blockers.length > 0 || needsReview || isSubmitting || isUploading) return
    setIsSubmitting(true)
    try {
      const result = await fulfillOrder({
        sellerId,
        order,
        delivery: plan.delivery,
        consumedKeys: plan.consumedKeys,
        kits,
        // A part of the order is not the whole of it.
        markDelivered: markDelivered && completesOrder,
        sellerPrivateKey,
      })
      if (result.pending) toast('Sent, awaiting confirmation')
      else toast.success('Delivered')
      for (const warning of result.warnings) toast.error(warning, { duration: 10_000 })
      onDelivered(result)
      onClose()
    } catch (error) {
      // Recovery details carry plaintext license keys: shown to the seller, never logged.
      logger.error('Digital delivery failed:', loggableFulfillmentError(error))
      onFailed(error)
      toast.error(fulfillmentErrorText(error), { duration: error instanceof KeyRecoveryError ? Infinity : 8_000 })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && handleClose()} variant="sheet" className="max-w-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
        <Dialog.Title className="font-semibold text-gray-900 dark:text-gray-100">
          {alreadyDelivered ? (sendsAgain ? 'Send again' : 'Deliver the rest') : 'Deliver digital items'}
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
            <div key={`${line.itemId}-${line.variantKey ?? ''}-${index}`} className={`p-3 border border-gray-200 dark:border-gray-800 rounded-lg space-y-2 ${selected.has(index) ? '' : 'opacity-60'}`}>
              <label className="flex items-start gap-2 text-sm font-medium">
                {lines.length > 1 && (
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={() => toggleLine(index)}
                    disabled={isSubmitting}
                    aria-label={`Include ${line.itemTitle} in this delivery`}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
                  />
                )}
                <span>
                  {line.itemTitle}
                  {line.variantKey && <span className="text-gray-500 font-normal"> ({line.variantKey.replace(/\|/g, ' / ')})</span>}
                  <span className="text-gray-500 font-normal"> ×{line.quantity}</span>
                  {confirmedSent[index]
                    ? <span className="ml-2 text-xs font-normal text-green-700 dark:text-green-300">Sent before</span>
                    : possiblySent[index] && <span className="ml-2 text-xs font-normal text-yellow-700 dark:text-yellow-300">May have been sent (not confirmed)</span>}
                </span>
              </label>
              {!selected.has(index) ? (
                <p className="text-xs text-gray-500">Not in this delivery.</p>
              ) : planned ? (
                <p className="text-xs text-gray-500">
                  {planned.assets.length} item{planned.assets.length === 1 ? '' : 's'}
                  {planned.licenseKeys ? ` · ${planned.licenseKeys.length} unique code${planned.licenseKeys.length === 1 ? '' : 's'}` : ''}
                  {planned.instructions ? ' · instructions' : ''}
                </p>
              ) : (
                <p className="text-xs text-yellow-700 dark:text-yellow-300">No delivery content saved for this product.</p>
              )}
              <details>
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                  Add a link, code or file for this order only
                </summary>
                <div className="mt-2">
                  <DigitalAssetListEditor
                    assets={extras[line.itemId] ?? []}
                    onChange={(update) => setExtras((prev) => ({ ...prev, [line.itemId]: update(prev[line.itemId] ?? []) }))}
                    onBusyChange={(busy) => setLineUploading(`${line.itemId}-${line.variantKey ?? ''}-${index}`, busy)}
                    identityId={sellerId}
                    disabled={isSubmitting}
                    forOneOrder
                  />
                </div>
              </details>
            </div>
          )
        })}

        {lines.length > 1 && (
          <p className="text-xs text-gray-500">
            Too much for one delivery? Untick some items, deliver, then deliver the rest. Each delivery is its own receipt.
          </p>
        )}

        {resendSellsKeys && (
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeNewKeys}
              onChange={(e) => setIncludeNewKeys(e.target.checked)}
              disabled={isSubmitting}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
            />
            <span className="text-sm">
              Issue new unique codes for items sent before
              <span className="block text-xs text-gray-500">The codes from the earlier delivery stay in the buyer&apos;s library either way.</span>
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
            checked={markDelivered && completesOrder}
            onChange={(e) => setMarkDelivered(e.target.checked)}
            disabled={isSubmitting || !completesOrder}
            className="w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
          />
          <span className="text-sm">
            Also mark the order Delivered
            {!completesOrder && <span className="block text-xs text-gray-500">Once every item has a confirmed delivery.</span>}
          </span>
        </label>

        {warnings.length > 0 && (
          <div role="alert" className="p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg space-y-2">
            <p className="text-sm font-medium text-orange-900 dark:text-orange-100">This order does not match your listings</p>
            {warnings.map((warning, index) => (
              <p key={index} className="flex items-start gap-2 text-sm text-orange-800 dark:text-orange-200">
                <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
                {warning.text}
              </p>
            ))}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
                disabled={isSubmitting}
                className="mt-0.5 w-4 h-4 rounded border-gray-300 text-yappr-500 focus:ring-yappr-500"
              />
              <span className="text-sm">
                I checked what this buyer ordered and paid for
                <span className="block text-xs text-gray-500">The buyer writes the order, so its titles and prices can differ from what is delivered: each product&apos;s own content is sent.</span>
              </span>
            </label>
          </div>
        )}

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
        <Button onClick={() => { handleSubmit().catch((error) => logger.error(error)) }} disabled={blockers.length > 0 || needsReview || isSubmitting || isUploading}>
          {isSubmitting ? 'Delivering…' : isUploading ? 'Uploading…' : 'Deliver'}
        </Button>
      </div>
    </Modal>
  )
}
