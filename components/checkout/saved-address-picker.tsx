'use client'

import { BookmarkIcon, PencilIcon } from '@heroicons/react/24/outline'
import { CheckCircleIcon } from '@heroicons/react/24/solid'
import type { SavedAddress } from '@/lib/types'

interface SavedAddressPickerProps {
  addresses: SavedAddress[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onManage: () => void
}

export function SavedAddressPicker({
  addresses,
  selectedId,
  onSelect,
  onManage
}: SavedAddressPickerProps) {
  if (addresses.length === 0) {
    return null
  }

  const formatAddressPreview = (address: SavedAddress) => {
    const parts = [
      address.address.street,
      address.address.city,
      address.address.state,
      address.address.postalCode
    ].filter(Boolean)
    return parts.join(', ')
  }

  return (
    <div className="p-4 border-b border-gray-200 dark:border-gray-800">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <BookmarkIcon className="h-4 w-4" />
          Saved Addresses
        </div>
        <button
          type="button"
          onClick={onManage}
          className="text-sm text-yappr-500 hover:text-yappr-600 flex items-center gap-1"
        >
          <PencilIcon className="h-3 w-3" />
          Manage
        </button>
      </div>

      <div className="space-y-2">
        {addresses.map((address) => (
          <button
            key={address.id}
            type="button"
            onClick={() => onSelect(address.id)}
            className={`w-full p-3 rounded-lg border transition-colors text-left flex items-start gap-3 ${
              selectedId === address.id
                ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-950/20'
                : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
            }`}
          >
            <div
              className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                selectedId === address.id
                  ? 'border-yappr-500 bg-yappr-500'
                  : 'border-gray-300 dark:border-gray-600'
              }`}
            >
              {selectedId === address.id && (
                <CheckCircleIcon className="h-4 w-4 text-white" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{address.label}</span>
                {address.isDefault && (
                  <span className="text-xs px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-gray-600 dark:text-gray-400">
                    Default
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                {address.address.name}
              </p>
              <p className="text-sm text-gray-500 truncate">
                {formatAddressPreview(address)}
              </p>
            </div>
          </button>
        ))}

        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`w-full p-3 rounded-lg border transition-colors text-left flex items-start gap-3 ${
            selectedId === null
              ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-950/20'
              : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
          }`}
        >
          <div
            className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
              selectedId === null
                ? 'border-yappr-500 bg-yappr-500'
                : 'border-gray-300 dark:border-gray-600'
            }`}
          >
            {selectedId === null && (
              <CheckCircleIcon className="h-4 w-4 text-white" />
            )}
          </div>
          <div className="flex-1">
            <span className="font-medium">Use a different address</span>
            <p className="text-sm text-gray-500">Enter a new shipping address</p>
          </div>
        </button>
      </div>
    </div>
  )
}
