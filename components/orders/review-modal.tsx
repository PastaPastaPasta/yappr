'use client'

import { logger } from '@/lib/logger';
import { useId, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Modal } from '@/components/ui/modal'
import { XMarkIcon, BuildingStorefrontIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { StarRatingInput } from '@/components/store/star-rating-input'
import { storeReviewService } from '@/lib/services/store-review-service'
import { itemReviewService } from '@/lib/services/item-review-service'
import { handleInsufficientYapp } from '@/hooks/use-buy-yapp-modal'
import { STOREFRONT_YAPP_TOKEN_COSTS, storefrontIsV2 } from '@/lib/constants'
import toast from 'react-hot-toast'
import type { StoreOrder, Store, OrderPayload } from '@/lib/types'

interface ReviewModalProps {
  isOpen: boolean
  onClose: () => void
  order: StoreOrder
  store: Store
  /** The decrypted order, so each purchased item can be rated too. */
  payload?: OrderPayload
  onSuccess: () => void
}

const TITLE_LIMIT = 100
const CONTENT_LIMIT = 1000
/** Indexed by the star rating, 0 meaning "not rated yet". */
const RATING_LABELS = ['Tap a star to rate', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent']

export function ReviewModal({
  isOpen,
  onClose,
  order,
  store,
  payload,
  onSuccess
}: ReviewModalProps) {
  const formId = useId()
  const [rating, setRating] = useState(0)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [itemRatings, setItemRatings] = useState<Record<string, number>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  // One entry per distinct purchased item (variants collapse onto the item).
  // Item reviews only exist on the v2 contract.
  const purchasedItems = storefrontIsV2()
    ? Array.from(new Map((payload?.items ?? []).map((line) => [line.itemId, line.itemTitle])).entries())
    : []
  const ratedItems = Object.entries(itemRatings).filter(([, value]) => value > 0)
  const yappCost = STOREFRONT_YAPP_TOKEN_COSTS.storeReview + ratedItems.length * STOREFRONT_YAPP_TOKEN_COSTS.itemReview

  const canSubmit = rating >= 1 && rating <= 5 && !isSubmitting

  const handleSubmit = async () => {
    if (!canSubmit) return

    setIsSubmitting(true)
    try {
      await storeReviewService.createReview(order.buyerId, {
        storeId: store.id,
        orderId: order.id,
        // The order's own sellerId is what consensus agrees the review against.
        sellerId: order.sellerId,
        rating,
        title: title.trim() || undefined,
        content: content.trim() || undefined
      })

      // Item reviews are separate documents (one transition each); a failure
      // here leaves the store review standing, so report it without undoing.
      const failedItems: string[] = []
      for (let index = 0; index < ratedItems.length; index++) {
        const [itemId, itemRating] = ratedItems[index]
        try {
          await itemReviewService.createItemReview(order.buyerId, {
            storeId: store.id,
            itemId,
            orderId: order.id,
            rating: itemRating
          })
        } catch (error) {
          logger.error(`Failed to submit item review for ${itemId}:`, error)
          if (handleInsufficientYapp(error, 'You ran out of YAPP before every item review was posted.')) {
            // Nothing after this one was attempted either.
            failedItems.push(...ratedItems.slice(index).map(([id]) => id))
            break
          }
          failedItems.push(itemId)
        }
      }

      if (failedItems.length === 0) {
        toast.success('Review submitted!')
      } else {
        toast.error(`Store review submitted, but ${failedItems.length} item ${failedItems.length === 1 ? 'rating' : 'ratings'} failed. Item ratings cannot be retried.`)
      }
      handleClose()
      onSuccess()
    } catch (error) {
      logger.error('Failed to submit review:', error)
      if (!handleInsufficientYapp(error, `A review costs ${yappCost} YAPP.`)) {
        toast.error('Failed to submit review. Please try again.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    setRating(0)
    setTitle('')
    setContent('')
    setItemRatings({})
    onClose()
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && handleClose()} variant="sheet" className="max-w-md">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                      <Dialog.Title className="font-semibold text-gray-900 dark:text-gray-100">
                        Leave a Review
                      </Dialog.Title>
                      <IconButton aria-label="Close review" onClick={handleClose}>
                        <XMarkIcon className="h-5 w-5" />
                      </IconButton>
                    </div>

                    {/* Content */}
                    <div className="p-4 space-y-4">
                      {/* Store Info */}
                      <div className="flex items-center gap-3 pb-4 border-b border-gray-100 dark:border-gray-800">
                        <div className="w-12 h-12 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
                          {store.logoUrl ? (
                            <img
                              src={store.logoUrl}
                              alt={store.name}
                              className="w-full h-full rounded-lg object-cover"
                            />
                          ) : (
                            <BuildingStorefrontIcon className="h-6 w-6 text-gray-400" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium">{store.name}</p>
                          <Dialog.Description className="text-sm text-gray-500">How was your experience?</Dialog.Description>
                        </div>
                      </div>

                      {/* Star Rating */}
                      <div className="flex flex-col items-center gap-2 py-2">
                        <StarRatingInput
                          value={rating}
                          onChange={setRating}
                          size="lg"
                          disabled={isSubmitting}
                        />
                        <p className="text-sm text-gray-500">{RATING_LABELS[rating]}</p>
                      </div>

                      {/* Title Input */}
                      <div>
                        <label htmlFor={`${formId}-title`} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Title <span className="text-gray-400">(optional)</span>
                        </label>
                        <input
                          id={`${formId}-title`}
                          type="text"
                          value={title}
                          onChange={(e) => setTitle(e.target.value.slice(0, TITLE_LIMIT))}
                          placeholder="Summarize your experience"
                          disabled={isSubmitting}
                          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent focus:outline-none focus:ring-2 focus:ring-yappr-500 disabled:opacity-50"
                        />
                        <p className="text-xs text-gray-400 mt-1 text-right">
                          {title.length}/{TITLE_LIMIT}
                        </p>
                      </div>

                      {/* Per-item ratings (optional; each publishes that this order contained the item) */}
                      {purchasedItems.length > 0 && (
                        <fieldset className="space-y-2">
                          <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Rate the items <span className="text-gray-400">(optional)</span>
                          </legend>
                          {purchasedItems.map(([itemId, itemTitle]) => (
                            <div key={itemId} className="flex items-center justify-between gap-3">
                              <span className="text-sm truncate">{itemTitle}</span>
                              <StarRatingInput
                                value={itemRatings[itemId] ?? 0}
                                onChange={(value) => setItemRatings((prev) => ({ ...prev, [itemId]: value }))}
                                size="sm"
                                disabled={isSubmitting}
                              />
                            </div>
                          ))}
                          <p className="text-xs text-gray-400">
                            Rating an item makes it public that this order included it. Item ratings are submitted once with the review.
                          </p>
                        </fieldset>
                      )}

                      {/* Content Input */}
                      <div>
                        <label htmlFor={`${formId}-content`} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Review <span className="text-gray-400">(optional)</span>
                        </label>
                        <textarea
                          id={`${formId}-content`}
                          value={content}
                          onChange={(e) => setContent(e.target.value.slice(0, CONTENT_LIMIT))}
                          placeholder="Share details of your experience..."
                          rows={4}
                          disabled={isSubmitting}
                          className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent resize-none focus:outline-none focus:ring-2 focus:ring-yappr-500 disabled:opacity-50"
                        />
                        <p className="text-xs text-gray-400 mt-1 text-right">
                          {content.length}/{CONTENT_LIMIT}
                        </p>
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-neutral-950">
                      <Button
                        variant="ghost"
                        onClick={handleClose}
                        disabled={isSubmitting}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                      >
                        {isSubmitting ? (
                          <span className="flex items-center gap-2">
                            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Submitting...
                          </span>
                        ) : storefrontIsV2() ? (
                          `Submit Review (${yappCost} YAPP)`
                        ) : (
                          'Submit Review'
                        )}
                      </Button>
                    </div>
    </Modal>
  )
}
