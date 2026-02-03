'use client'

import { EnvelopeIcon, LockClosedIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import type { BuyerContact } from '@/lib/types'

interface DeliveryDetailsFormProps {
  contact: BuyerContact
  onContactChange: (contact: BuyerContact) => void
  onSubmit: () => void
}

export function DeliveryDetailsForm({
  contact,
  onContactChange,
  onSubmit
}: DeliveryDetailsFormProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!contact.email) return
    onSubmit()
  }

  const updateContact = (field: keyof BuyerContact, value: string) => {
    onContactChange({ ...contact, [field]: value || undefined })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      <div className="px-4 pt-4">
        <div className="flex items-start gap-2 p-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-800 dark:text-green-200">
          <LockClosedIcon className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>Your delivery details are encrypted and only shared with the merchant after you complete your order.</span>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2 text-lg font-medium">
          <EnvelopeIcon className="h-5 w-5 text-yappr-500" />
          Delivery Details
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Email *</label>
          <input
            type="email"
            value={contact.email || ''}
            onChange={(e) => updateContact('email', e.target.value)}
            required
            className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Phone (optional)</label>
          <input
            type="tel"
            value={contact.phone || ''}
            onChange={(e) => updateContact('phone', e.target.value)}
            className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
        </div>
      </div>

      <div className="p-4">
        <Button type="submit" className="w-full">
          Continue to Policies
        </Button>
      </div>
    </form>
  )
}
