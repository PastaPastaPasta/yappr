'use client'

import { useState } from 'react'
import { PlusIcon, TrashIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { APPROVED_PAYMENT_SCHEMES } from '@/lib/services/unified-profile-service'

interface PaymentUriInputProps {
  uris: string[]
  onChange: (uris: string[]) => void
  maxUris?: number
  disabled?: boolean
}

// Helper to get scheme display name
const SCHEME_LABELS: Record<string, string> = {
  'dash:': 'Dash',
  'bitcoin:': 'Bitcoin',
  'litecoin:': 'Litecoin',
  'ethereum:': 'Ethereum',
  'monero:': 'Monero',
  'dogecoin:': 'Dogecoin',
  'bitcoincash:': 'Bitcoin Cash',
  'zcash:': 'Zcash',
  'stellar:': 'Stellar',
  'ripple:': 'XRP',
  'solana:': 'Solana',
  'cardano:': 'Cardano',
  'polkadot:': 'Polkadot',
  'tron:': 'Tron',
  'lightning:': 'Lightning',
}

function getSchemeLabel(uri: string): string {
  const lowerUri = uri.toLowerCase()
  for (const scheme of APPROVED_PAYMENT_SCHEMES) {
    if (lowerUri.startsWith(scheme)) {
      return SCHEME_LABELS[scheme] || scheme.replace(':', '')
    }
  }
  return 'Unknown'
}

function isValidPaymentUri(uri: string): boolean {
  if (!uri.trim()) return false
  const lowerUri = uri.toLowerCase()
  return APPROVED_PAYMENT_SCHEMES.some(scheme => lowerUri.startsWith(scheme))
}

function extractScheme(uri: string): string {
  const colonIndex = uri.indexOf(':')
  if (colonIndex > 0) {
    return uri.substring(0, colonIndex + 1).toLowerCase()
  }
  return ''
}

export function PaymentUriInput({
  uris,
  onChange,
  maxUris = 10,
  disabled = false,
}: PaymentUriInputProps) {
  const [newUri, setNewUri] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleAddUri = () => {
    if (!newUri.trim()) return

    if (!isValidPaymentUri(newUri)) {
      setError('Please enter a valid payment URI (e.g., dash:XnNh3..., bitcoin:bc1...)')
      return
    }

    if (uris.length >= maxUris) {
      setError(`Maximum ${maxUris} payment addresses allowed`)
      return
    }

    // Check for duplicates
    if (uris.some(u => u.toLowerCase() === newUri.toLowerCase())) {
      setError('This address is already added')
      return
    }

    onChange([...uris, newUri.trim()])
    setNewUri('')
    setError(null)
  }

  const handleRemoveUri = (index: number) => {
    const updated = uris.filter((_, i) => i !== index)
    onChange(updated)
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddUri()
    }
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        Payment Addresses
      </label>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Add cryptocurrency addresses where others can send you tips
      </p>

      {/* Existing URIs */}
      {uris.length > 0 && (
        <div className="space-y-2">
          {uris.map((uri, index) => (
            <div
              key={index}
              className="flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg"
            >
              <span className="px-2 py-0.5 text-xs font-medium bg-gray-200 dark:bg-gray-700 rounded">
                {getSchemeLabel(uri)}
              </span>
              <span className="flex-1 text-sm font-mono truncate text-gray-600 dark:text-gray-300">
                {uri.substring(uri.indexOf(':') + 1)}
              </span>
              <button
                type="button"
                onClick={() => handleRemoveUri(index)}
                disabled={disabled}
                className="p-1 text-gray-400 hover:text-red-500 disabled:opacity-50"
              >
                <TrashIcon className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new URI */}
      {uris.length < maxUris && (
        <div className="flex gap-2">
          <input
            type="text"
            value={newUri}
            onChange={(e) => {
              setNewUri(e.target.value)
              setError(null)
            }}
            onKeyPress={handleKeyPress}
            disabled={disabled}
            placeholder="dash:XnNh3... or bitcoin:bc1..."
            className="flex-1 px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-900
                       border-gray-300 dark:border-gray-600
                       focus:ring-2 focus:ring-blue-500 focus:border-transparent
                       disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={handleAddUri}
            disabled={disabled || !newUri.trim()}
            className="px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600
                       disabled:opacity-50 disabled:cursor-not-allowed
                       flex items-center gap-1"
          >
            <PlusIcon className="w-4 h-4" />
            Add
          </button>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-500">
          <ExclamationTriangleIcon className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Supported networks hint */}
      <div className="text-xs text-gray-400 dark:text-gray-500">
        Supported: Dash, Bitcoin, Litecoin, Ethereum, Monero, Dogecoin, Bitcoin Cash,
        Zcash, Stellar, XRP, Solana, Cardano, Polkadot, Tron, Lightning
      </div>
    </div>
  )
}
