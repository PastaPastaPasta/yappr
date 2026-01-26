'use client'

import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { XMarkIcon, BuildingStorefrontIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { StarRatingInput } from '@/components/store/star-rating-input'
import { storeReviewService } from '@/lib/services/store-review-service'
import { useSettingsStore } from '@/lib/store'
import toast from 'react-hot-toast'
import type { StoreOrder, Store } from '@/lib/types'

interface ReviewModalProps {
  isOpen: boolean
  onClose: () => void
  order: StoreOrder
  store: Store
  onSuccess: () => void
}

const TITLE_LIMIT = 100
const CONTENT_LIMIT = 1000

export function ReviewModal({
  isOpen,
  onClose,
  order,
  store,
  onSuccess
}: ReviewModalProps) {
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const [rating, setRating] = useState(0)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const canSubmit = rating >= 1 && rating <= 5 && !isSubmitting

  const handleSubmit = async () => {
    if (!canSubmit) return

    setIsSubmitting(true)
    try {
      await storeReviewService.createReview(order.buyerId, {
        storeId: store.id,
        orderId: order.id,
        sellerId: store.ownerId,
        rating,
        title: title.trim() || undefined,
        content: content.trim() || undefined
      })

      toast.success('Review submitted!')
      handleClose()
      onSuccess()
    } catch (error) {
      console.error('Failed to submit review:', error)
      toast.error('Failed to submit review. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    setRating(0)
    setTitle('')
    setContent('')
    onClose()
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`fixed inset-0 bg-black/60 z-50 flex items-center justify-center px-4 ${
                  potatoMode ? '' : 'backdrop-blur-sm'
                }`}
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 20 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="w-full max-w-md bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                      <Dialog.Title className="font-semibold text-gray-900 dark:text-gray-100">
                        Leave a Review
                      </Dialog.Title>
                      <IconButton onClick={handleClose}>
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
                          <p className="text-sm text-gray-500">How was your experience?</p>
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
                        <p className="text-sm text-gray-500">
                          {rating === 0 && 'Tap a star to rate'}
                          {rating === 1 && 'Poor'}
                          {rating === 2 && 'Fair'}
                          {rating === 3 && 'Good'}
                          {rating === 4 && 'Very Good'}
                          {rating === 5 && 'Excellent'}
                        </p>
                      </div>

                      {/* Title Input */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Title <span className="text-gray-400">(optional)</span>
                        </label>
                        <input
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

                      {/* Content Input */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Review <span className="text-gray-400">(optional)</span>
                        </label>
                        <textarea
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
                        ) : (
                          'Submit Review'
                        )}
                      </Button>
                    </div>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
