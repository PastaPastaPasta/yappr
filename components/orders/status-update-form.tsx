'use client'

import { Button } from '@/components/ui/button'
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
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
      <h4 className="font-medium">Update Order Status</h4>

      <div>
        <label className="block text-sm font-medium mb-1">Status</label>
        <select
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
            <label className="block text-sm font-medium mb-1">Carrier</label>
            <select
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
            <label className="block text-sm font-medium mb-1">Tracking Number</label>
            <input
              type="text"
              value={trackingNumber}
              onChange={(e) => onTrackingNumberChange(e.target.value)}
              placeholder="Enter tracking number"
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
            />
          </div>
        </>
      )}

      <div>
        <label className="block text-sm font-medium mb-1">Message to Buyer</label>
        <textarea
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Optional message..."
          rows={2}
          className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 resize-none"
        />
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
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Saving...' : 'Save Status'}
        </Button>
      </div>
    </div>
  )
}
