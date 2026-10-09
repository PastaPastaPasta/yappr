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
import { coverageChanged, deliveredFor, deliveryCompletesOrder, digitalLines, isDigitalOnly, lineCoverage, lineProblems, MAX_DELIVERY_MESSAGE_LENGTH, planBlockers, planDelivery, wholeOrderProblems, withHeldDeliveries, type ItemListing, type LineCoverage } from '@/lib/services/digital-delivery-plan'
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
  /** The order's earlier deliveries (decrypted where possible), as just read: which lines they covered. */
  previousDeliveries: readonly OrderDelivery[]
  /** Re-read the order's deliveries from the chain (rejects when the read fails). */
  refreshDeliveries: () => Promise<OrderDelivery[]>
  onDelivered: (result: FulfillOrderResult) => void
  /** A failed delivery may still have rewritten pools (see FulfillmentError). */
  onFailed: (error: unknown) => void
}

/** Unique codes each line may still be owed: never one that may already be out. */
const owedCodesFor = (lines: readonly OrderItem[], coverage: readonly LineCoverage[], sellsCodes: readonly boolean[]) =>
  lines.map((line, index) => (sellsCodes[index] ? Math.max(0, line.quantity - coverage[index].possiblyCodes) : 0))

const codesByLine = (codes: readonly number[]): Record<number, number> => Object.fromEntries(codes.map((count, index) => [index, count]))

/** The lines still to deliver (every line when none is). */
function defaultSelection(coverage: readonly LineCoverage[], owedCodes: readonly number[]): ReadonlySet<number> {
  const pending = coverage.flatMap((line, index) => (!line.possibly || owedCodes[index] > 0 ? [index] : []))
  return new Set(pending.length > 0 ? pending : coverage.map((_, index) => index))
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
  previousDeliveries,
  refreshDeliveries,
  onDelivered,
  onFailed,
}: DeliverDigitalModalProps) {
  const formId = useId()
  const lines = useMemo(() => digitalLines(payload), [payload])
  // The receipts this form's allocation is based on: re-checked against the
  // chain before sending, and replaced (with the allocation) if they changed.
  const [basis, setBasis] = useState<readonly OrderDelivery[]>(previousDeliveries)
  // Set when the re-check found new receipts and the allocation was redone.
  const [coverageMoved, setCoverageMoved] = useState(false)
  // What earlier receipts hold for each line (lineCoverage): "possibly" counts
  // pending receipts and ones this device cannot read, so no code is sent
  // twice by default; "confirmed" alone counts towards marking the order Delivered.
  const coverage = useMemo(() => lines.map((line) => lineCoverage(line, basis)), [lines, basis])
  const sellsCodes = useMemo(() => lines.map((line) => kits.get(line.itemId)?.kit.licenseKeys !== undefined), [lines, kits])
  const owedCodes = owedCodesFor(lines, coverage, sellsCodes)
  // The lines this delivery covers. A delivery too large for one receipt goes
  // out in parts: untick some lines (or send fewer codes), deliver, then the rest.
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => defaultSelection(coverage, owedCodes))
  // Unique codes each code-selling line takes now: by default what it is still owed.
  const [codesNow, setCodesNow] = useState<Record<number, number>>(() => codesByLine(owedCodes))
  const [message, setMessage] = useState('')
  const [markDelivered, setMarkDelivered] = useState(isDigitalOnly(payload.items))
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
  const sending = lines.map((_, index) => ({ selected: selected.has(index), sellsCodes: sellsCodes[index], codes: codesNow[index] ?? 0 }))
  // Whether this delivery (which marks the order only if it confirms) finishes
  // the order, as far as the receipts the form shows go; decided again from
  // the receipts read just before sending.
  const completesOrder = deliveryCompletesOrder(lines, basis, sending)
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
  // What goes out: each chosen line under its listing's title (the buyer's may
  // be anything), taking `codesNow` codes. A line taking none plans with its
  // own quantity but no codes.
  const { deliveryPayload, takesNoCodes } = useMemo(() => {
    const noCodes = new Set<OrderItem>()
    const items = lines.flatMap((line, index) => {
      if (!selected.has(index)) return []
      const codes = sellsCodes[index] ? codesNow[index] ?? 0 : line.quantity
      const planned: OrderItem = { ...line, itemTitle: listings.get(line.itemId)?.title ?? line.itemTitle, ...(codes > 0 ? { quantity: codes } : {}) }
      if (codes === 0) noCodes.add(planned)
      return [planned]
    })
    return { deliveryPayload: { items }, takesNoCodes: noCodes }
  }, [lines, selected, sellsCodes, codesNow, listings])
  const plan = useMemo(() => planDelivery(deliveryPayload, effectiveKits, listings, message, (line) => takesNoCodes.has(line)), [deliveryPayload, effectiveKits, listings, message, takesNoCodes])
  // The buyer wrote these lines: the kit sent is chosen by itemId, whatever title or price they claim.
  const problems = useMemo(() => lineProblems(selectedPayload, order.storeId, listings), [selectedPayload, order.storeId, listings])
  const blockers = useMemo(() => [
    ...(selectedLines.length === 0 ? ['Choose at least one item to deliver.'] : []),
    // Over the whole order: unticking a line must not hide its problem.
    ...wholeOrderProblems(payload),
    ...problems.filter((problem) => problem.blocking).map((problem) => problem.text),
    ...planBlockers(plan),
  ], [selectedLines, payload, problems, plan])
  const warnings = problems.filter((problem) => !problem.blocking)
  const needsReview = warnings.length > 0 && !reviewed
  const sendsAgain = lines.some((_, index) => selected.has(index) && coverage[index].possibly)

  const handleClose = () => {
    if (isSubmitting) return
    onClose()
  }

  /**
   * Re-read the order's receipts before anything is taken from a pool. If they
   * changed since the form was filled in (a delivery from another device or
   * tab), redo the allocation from them and let the seller check it: never
   * send codes chosen against receipts that are out of date. Returns the
   * receipts as just read when the allocation still holds, else null.
   */
  const receiptsIfUnchanged = async (): Promise<OrderDelivery[] | null> => {
    let latest: OrderDelivery[]
    try {
      // Receipts already held that the read does not show yet still count.
      latest = withHeldDeliveries(await refreshDeliveries(), basis)
    } catch (error) {
      logger.error('Could not re-check the order\'s deliveries:', error)
      toast.error('Could not check what was already delivered for this order, so nothing was sent. Try again.')
      return null
    }
    if (!coverageChanged(lines, basis, latest)) return latest
    const fresh = lines.map((line) => lineCoverage(line, latest))
    const owed = owedCodesFor(lines, fresh, sellsCodes)
    setBasis(latest)
    setSelected(defaultSelection(fresh, owed))
    setCodesNow(codesByLine(owed))
    // The new selection may hold lines with warnings the seller has not checked.
    setReviewed(false)
    setCoverageMoved(true)
    return null
  }

  const handleSubmit = async () => {
    if (blockers.length > 0 || needsReview || isSubmitting || isUploading) return
    setIsSubmitting(true)
    setCoverageMoved(false)
    try {
      const latest = await receiptsIfUnchanged()
      if (!latest) return
      const result = await fulfillOrder({
        sellerId,
        order,
        delivery: plan.delivery,
        consumedKeys: plan.consumedKeys,
        kits,
        // A part of the order is not the whole of it. Decided from the receipts
        // just read: an earlier part that confirmed since the form opened counts.
        markDelivered: markDelivered && deliveryCompletesOrder(lines, latest, sending),
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
          {basis.length > 0 ? (sendsAgain ? 'Send again' : 'Deliver the rest') : 'Deliver digital items'}
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
          const planned = plan.delivery.items.find((item) => deliveredFor(item, line))
          return (
            <div key={`${line.itemId}-${line.variantId ?? ''}-${index}`} className={`p-3 border border-gray-200 dark:border-gray-800 rounded-lg space-y-2 ${selected.has(index) ? '' : 'opacity-60'}`}>
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
                  {line.variantLabel && <span className="text-gray-500 font-normal"> ({line.variantLabel})</span>}
                  <span className="text-gray-500 font-normal"> ×{line.quantity}</span>
                  {coverage[index].confirmed
                    ? <span className="ml-2 text-xs font-normal text-green-700 dark:text-green-300">Sent before</span>
                    : coverage[index].possibly && <span className="ml-2 text-xs font-normal text-yellow-700 dark:text-yellow-300">May have been sent (not confirmed)</span>}
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
              {selected.has(index) && sellsCodes[index] && (
                <label className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  Unique codes to send now
                  <input
                    type="number"
                    min={0}
                    max={line.quantity}
                    value={codesNow[index] ?? 0}
                    onChange={(e) => {
                      const value = Math.max(0, Math.min(line.quantity, Math.floor(Number(e.target.value) || 0)))
                      setCodesNow((prev) => ({ ...prev, [index]: value }))
                    }}
                    disabled={isSubmitting}
                    className="w-16 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-transparent"
                  />
                  <span>
                    of {line.quantity}
                    {coverage[index].possiblyCodes > 0 && ` (${coverage[index].confirmedCodes} confirmed sent${coverage[index].possiblyCodes > coverage[index].confirmedCodes ? `, up to ${coverage[index].possiblyCodes - coverage[index].confirmedCodes} more pending or unreadable` : ''})`}
                  </span>
                  {(codesNow[index] ?? 0) > owedCodes[index] && (
                    <span className="w-full text-yellow-700 dark:text-yellow-300">More than this line may still be owed: the extra codes are new ones on top of those already sent.</span>
                  )}
                </label>
              )}
              <details>
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                  Add a link, code or file for this order only
                </summary>
                <div className="mt-2">
                  <DigitalAssetListEditor
                    assets={extras[line.itemId] ?? []}
                    onChange={(update) => setExtras((prev) => ({ ...prev, [line.itemId]: update(prev[line.itemId] ?? []) }))}
                    onBusyChange={(busy) => setLineUploading(`${line.itemId}-${line.variantId ?? ''}-${index}`, busy)}
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
            Too much for one delivery? Untick some items (or send fewer codes), deliver, then deliver the rest. Each delivery is its own receipt.
          </p>
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

        {coverageMoved && (
          <div role="alert" className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="flex items-start gap-2 text-sm text-yellow-800 dark:text-yellow-200">
              <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
              Nothing was sent: this order got another delivery since you opened this form, perhaps from another device. What to send now has been worked out again from it. Check it, then press Deliver again.
            </p>
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
