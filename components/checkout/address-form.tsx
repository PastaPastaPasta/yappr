'use client'

import { TruckIcon, LockClosedIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { SavedAddressPicker } from './saved-address-picker'
import type { ShippingAddress, BuyerContact, SavedAddress } from '@/lib/types'

interface AddressFormProps {
  address: ShippingAddress
  contact: BuyerContact
  onAddressChange: (address: ShippingAddress) => void
  onContactChange: (contact: BuyerContact) => void
  onSubmit: () => void
  // Saved address props (optional)
  savedAddresses?: SavedAddress[]
  selectedSavedAddressId?: string | null
  onSavedAddressSelect?: (id: string | null) => void
  onManageSavedAddresses?: () => void
}

export function AddressForm({
  address,
  contact,
  onAddressChange,
  onContactChange,
  onSubmit,
  savedAddresses,
  selectedSavedAddressId,
  onSavedAddressSelect,
  onManageSavedAddresses
}: AddressFormProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!address.name || !address.street || !address.city || !address.postalCode || !address.country) return
    onSubmit()
  }

  // If a saved address is selected, show it as readonly
  const isUsingSavedAddress = selectedSavedAddressId !== null && selectedSavedAddressId !== undefined

  // Show saved addresses picker if available
  const showSavedAddressPicker = savedAddresses && savedAddresses.length > 0 && onSavedAddressSelect && onManageSavedAddresses

  const updateAddress = (field: keyof ShippingAddress, value: string) => {
    onAddressChange({ ...address, [field]: value })
  }

  const updateContact = (field: keyof BuyerContact, value: string) => {
    onContactChange({ ...contact, [field]: value || undefined })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      {/* Saved Address Picker */}
      {showSavedAddressPicker && (
        <SavedAddressPicker
          addresses={savedAddresses}
          selectedId={selectedSavedAddressId ?? null}
          onSelect={onSavedAddressSelect}
          onManage={onManageSavedAddresses}
        />
      )}

      {/* Encryption notice - always visible */}
      <div className="px-4 pt-4">
        <div className="flex items-start gap-2 p-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-800 dark:text-green-200">
          <LockClosedIcon className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>Your address is encrypted and will only be shared with the merchant after you complete your order.</span>
        </div>
      </div>

      {/* Show form only if not using a saved address */}
      {!isUsingSavedAddress && (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2 text-lg font-medium">
            <TruckIcon className="h-5 w-5 text-yappr-500" />
            Shipping Address
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Full Name *</label>
            <input
              type="text"
              value={address.name}
              onChange={(e) => updateAddress('name', e.target.value)}
              required
              className="w-full px-4 py-2 border border-surface-200 dark:border-neutral-750 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Street Address *</label>
            <input
              type="text"
              value={address.street}
              onChange={(e) => updateAddress('street', e.target.value)}
              required
              className="w-full px-4 py-2 border border-surface-200 dark:border-neutral-750 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">City *</label>
              <input
                type="text"
                value={address.city}
                onChange={(e) => updateAddress('city', e.target.value)}
                required
                className="w-full px-4 py-2 border border-surface-200 dark:border-neutral-750 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">State/Province</label>
              <input
                type="text"
                value={address.state || ''}
                onChange={(e) => updateAddress('state', e.target.value)}
                className="w-full px-4 py-2 border border-surface-200 dark:border-neutral-750 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Postal Code *</label>
              <input
                type="text"
                value={address.postalCode}
                onChange={(e) => updateAddress('postalCode', e.target.value)}
                required
                className="w-full px-4 py-2 border border-surface-200 dark:border-neutral-750 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Country *</label>
              <select
                value={address.country}
                onChange={(e) => updateAddress('country', e.target.value)}
                className="w-full px-4 py-2 border border-surface-200 dark:border-neutral-750 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
              >
                <option value="US">United States</option>
                <option value="CA">Canada</option>
                <option value="GB">United Kingdom</option>
                <option value="AU">Australia</option>
                <option value="DE">Germany</option>
                <option value="FR">France</option>
              </select>
            </div>
          </div>

          <div className="border-t border-surface-200 dark:border-neutral-750 pt-4 mt-4">
            <div className="flex items-center gap-2 text-lg font-medium mb-4">
              Contact Information
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input
                  type="email"
                  value={contact.email || ''}
                  onChange={(e) => updateContact('email', e.target.value)}
                  className="w-full px-4 py-2 border border-surface-200 dark:border-neutral-750 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Phone</label>
                <input
                  type="tel"
                  value={contact.phone || ''}
                  onChange={(e) => updateContact('phone', e.target.value)}
                  className="w-full px-4 py-2 border border-surface-200 dark:border-neutral-750 rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="p-4">
        <Button type="submit" className="w-full">
          Continue to Shipping
        </Button>
      </div>
    </form>
  )
}
