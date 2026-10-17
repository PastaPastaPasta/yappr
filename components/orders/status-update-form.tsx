'use client'

import { encodeOrderStatusNote, STATUS_NOTE_CIPHERTEXT_OVERHEAD, type OrderStatusNote } from '@/lib/crypto/digital-delivery'
import { STATUS_NOTE_MAX_BYTES } from '@/lib/storefront/storefront-contract'
import { fitTextChange } from '@/lib/text-limits'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { storefrontStatusIsSealed } from '@/lib/constants'
import { orderStatusService } from '@/lib/services/order-status-service'
import type { OrderStatus } from '@/lib/types'

interface StatusUpdateFormProps {
  currentStatus: OrderStatus
  onStatusChange: (status: OrderStatus) => void
  trackingNumber: string
  onTrackingNumberChange: (value: string) => void
  trackingCarrier: string
  onTrackingCarrierChange: (value: string) => void
  message: string
  onMessageChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  isSubmitting: boolean
}

const statusOptions: OrderStatus[] = [
  'pending',
  'payment_received',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'disputed'
]

const carrierOptions = [
  'USPS',
  'UPS',
  'FedEx',
  'DHL',
  'Canada Post',
  'Royal Mail',
  'Australia Post',
  'Other'
]

export function StatusUpdateForm({
  currentStatus,
  onStatusChange,
  trackingNumber,
  onTrackingNumberChange,
  trackingCarrier,
  onTrackingCarrierChange,
  message,
  onMessageChange,
  onSubmit,
  onCancel,
  isSubmitting
}: StatusUpdateFormProps) {
  const formId = useId()
  const note = { trackingNumber, trackingCarrier, message }
  const noteBytes = (value: OrderStatusNote) => encodeOrderStatusNote(value).length + STATUS_NOTE_CIPHERTEXT_OVERHEAD
  const sealed = storefrontStatusIsSealed()
  const bytes = noteBytes(note)
  const updateNote = (field: keyof OrderStatusNote, text: string, change: (value: string) => void) => {
    if (!sealed) { change(text); return }
    change(fitTextChange(note[field] ?? '', text, value => noteBytes({ ...note, [field]: value }) <= STATUS_NOTE_MAX_BYTES))
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
      <h4 className="font-medium">Update Order Status</h4>

      <div>
        <label htmlFor={`${formId}-status`} className="block text-sm font-medium mb-1">Status</label>
        <select
          id={`${formId}-status`}
          value={currentStatus}
          onChange={(e) => onStatusChange(e.target.value as OrderStatus)}
          className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
        >
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {orderStatusService.getStatusLabel(s)}
            </option>
          ))}
        </select>
      </div>

      {currentStatus === 'shipped' && (
        <>
          <div>
            <label htmlFor={`${formId}-carrier`} className="block text-sm font-medium mb-1">Carrier</label>
            <select
              id={`${formId}-carrier`}
              value={trackingCarrier}
              onChange={(e) => onTrackingCarrierChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
            >
              <option value="">Select carrier...</option>
              {carrierOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${formId}-tracking`} className="block text-sm font-medium mb-1">Tracking Number</label>
            <input
              type="text"
              id={`${formId}-tracking`}
              value={trackingNumber}
              onChange={(e) => updateNote('trackingNumber', e.target.value, onTrackingNumberChange)}
              placeholder="Enter tracking number"
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
            />
          </div>
        </>
      )}

      <div>
        <label htmlFor={`${formId}-message`} className="block text-sm font-medium mb-1">Message to Buyer</label>
        <textarea
          id={`${formId}-message`}
          value={message}
          onChange={(e) => updateNote('message', e.target.value, onMessageChange)}
          placeholder="Optional message..."
          rows={2}
          className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
        />
        {sealed && <p className="text-xs text-gray-500 text-right">{bytes}/{STATUS_NOTE_MAX_BYTES} bytes</p>}
        {sealed && (
          <p className="mt-1 text-xs text-gray-500">Tracking details and your message are sent privately to the buyer.</p>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={isSubmitting || (sealed && bytes > STATUS_NOTE_MAX_BYTES)}
        >
          {isSubmitting ? 'Saving...' : 'Save Status'}
        </Button>
      </div>
    </div>
  )
}
