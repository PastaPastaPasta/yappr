'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { XMarkIcon, WalletIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { PaymentSchemeIcon, PAYMENT_SCHEME_LABELS } from '@/components/ui/payment-icons'
import { APPROVED_PAYMENT_SCHEMES } from '@/lib/services/unified-profile-service'

// Supported payment schemes with their details
const PAYMENT_SCHEMES = [
  { scheme: 'tdash:', label: 'Dash (Testnet)', placeholder: 'yxxxxxxxxxxxxxxxxxxxxxxxxYYYYYY', hint: 'Your testnet Dash wallet address' },
  { scheme: 'dash:', label: 'Dash', placeholder: 'XxxxxxxxxxxxxxxxxxxxxxxxxYYYYYY', hint: 'Your Dash wallet address' },
  { scheme: 'bitcoin:', label: 'Bitcoin', placeholder: 'bc1qxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Bitcoin wallet address' },
  { scheme: 'ethereum:', label: 'Ethereum', placeholder: '0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Ethereum wallet address' },
  { scheme: 'litecoin:', label: 'Litecoin', placeholder: 'ltc1qxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Litecoin wallet address' },
  { scheme: 'monero:', label: 'Monero', placeholder: '4xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Monero wallet address' },
  { scheme: 'dogecoin:', label: 'Dogecoin', placeholder: 'Dxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Dogecoin wallet address' },
  { scheme: 'bitcoincash:', label: 'Bitcoin Cash', placeholder: 'bitcoincash:qxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Bitcoin Cash wallet address' },
  { scheme: 'zcash:', label: 'Zcash', placeholder: 't1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Zcash wallet address' },
  { scheme: 'stellar:', label: 'Stellar', placeholder: 'Gxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Stellar (XLM) wallet address' },
  { scheme: 'ripple:', label: 'XRP', placeholder: 'rxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your XRP wallet address' },
  { scheme: 'solana:', label: 'Solana', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Solana wallet address' },
  { scheme: 'cardano:', label: 'Cardano', placeholder: 'addr1xxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Cardano (ADA) wallet address' },
  { scheme: 'polkadot:', label: 'Polkadot', placeholder: '1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Polkadot (DOT) wallet address' },
  { scheme: 'tron:', label: 'Tron', placeholder: 'Txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Tron (TRX) wallet address' },
  { scheme: 'lightning:', label: 'Lightning', placeholder: 'lnbc1xxxxxxxxxxxxxxxxx', hint: 'Your Lightning address or invoice' },
] as const

interface PaymentMethodModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: {
    scheme: string
    address: string
    label?: string
  }) => Promise<void>
}

export function PaymentMethodModal({ isOpen, onClose, onSave }: PaymentMethodModalProps) {
  const [scheme, setScheme] = useState('tdash:')
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [customUri, setCustomUri] = useState('')
  const [customError, setCustomError] = useState('')

  if (!isOpen) return null

  const selectedScheme = PAYMENT_SCHEMES.find(s => s.scheme === scheme) || PAYMENT_SCHEMES[0]

  const parseCustomUri = (uri: string): { scheme: string; address: string } | null => {
    const colonIndex = uri.indexOf(':')
    if (colonIndex <= 0) return null
    const s = uri.substring(0, colonIndex + 1).toLowerCase()
    const addr = uri.substring(colonIndex + 1)
    if (!addr.trim()) return null
    if (!APPROVED_PAYMENT_SCHEMES.includes(s as typeof APPROVED_PAYMENT_SCHEMES[number])) return null
    return { scheme: s, address: addr.trim() }
  }

  const handleSubmit = async () => {
    if (customMode) {
      const parsed = parseCustomUri(customUri.trim())
      if (!parsed) return
      setIsSubmitting(true)
      try {
        await onSave({
          scheme: parsed.scheme,
          address: parsed.address,
          label: label.trim() || undefined
        })
        setCustomUri('')
        setLabel('')
        setCustomError('')
        setCustomMode(false)
      } finally {
        setIsSubmitting(false)
      }
      return
    }

    if (!address.trim()) return

    setIsSubmitting(true)
    try {
      await onSave({
        scheme,
        address: address.trim(),
        label: label.trim() || undefined
      })
      // Reset form
      setAddress('')
      setLabel('')
      setScheme('tdash:')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative w-full max-w-md bg-white dark:bg-neutral-900 rounded-2xl shadow-xl"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <WalletIcon className="h-5 w-5 text-yappr-500" />
            <h2 className="text-lg font-bold">Add Payment Method</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Mode toggle */}
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <button
              type="button"
              onClick={() => setCustomMode(false)}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                !customMode
                  ? 'bg-yappr-500 text-white'
                  : 'bg-white dark:bg-neutral-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-neutral-750'
              }`}
            >
              Select Type
            </button>
            <button
              type="button"
              onClick={() => setCustomMode(true)}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                customMode
                  ? 'bg-yappr-500 text-white'
                  : 'bg-white dark:bg-neutral-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-neutral-750'
              }`}
            >
              Custom URI
            </button>
          </div>

          {customMode ? (
            <>
              {/* Custom URI input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Payment URI *
                </label>
                <input
                  type="text"
                  value={customUri}
                  onChange={(e) => {
                    setCustomUri(e.target.value)
                    if (customError) {
                      const parsed = parseCustomUri(e.target.value.trim())
                      if (parsed) setCustomError('')
                    }
                  }}
                  onBlur={() => {
                    const trimmed = customUri.trim()
                    if (trimmed && !parseCustomUri(trimmed)) {
                      setCustomError('Enter a valid URI in scheme:address format (e.g., dash:Xabc123...)')
                    } else {
                      setCustomError('')
                    }
                  }}
                  placeholder="e.g., dash:XnNh3biq9..."
                  className={`w-full px-4 py-3 rounded-lg border bg-white dark:bg-neutral-800 font-mono text-sm placeholder:text-gray-400 dark:placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent ${
                    customError ? 'border-red-400 dark:border-red-600' : 'border-gray-300 dark:border-gray-700'
                  }`}
                />
                {customError ? (
                  <p className="text-xs text-red-500 mt-1">{customError}</p>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">
                    Supported: {APPROVED_PAYMENT_SCHEMES.map(s => PAYMENT_SCHEME_LABELS[s] || s.replace(':', '')).join(', ')}
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Payment type grid */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Payment Type
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {PAYMENT_SCHEMES.map((s) => (
                    <button
                      key={s.scheme}
                      type="button"
                      onClick={() => setScheme(s.scheme)}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border transition-all ${
                        scheme === s.scheme
                          ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-900/20'
                          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                      }`}
                    >
                      <PaymentSchemeIcon scheme={s.scheme} size="lg" />
                      <span className={`text-xs font-medium text-center ${
                        scheme === s.scheme
                          ? 'text-yappr-600 dark:text-yappr-400'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}>
                        {s.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Address input */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Address *
                </label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={selectedScheme.placeholder}
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 font-mono text-sm placeholder:text-gray-400 dark:placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {selectedScheme.hint}
                </p>
              </div>
            </>
          )}

          {/* Label input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Label (optional)
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g., Main Wallet, Business Account"
              className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="flex gap-3 p-4 border-t border-gray-200 dark:border-gray-800">
          <Button
            variant="outline"
            className="flex-1"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={handleSubmit}
            disabled={isSubmitting || (customMode ? !parseCustomUri(customUri.trim()) : !address.trim())}
          >
            {isSubmitting ? 'Adding...' : 'Add Payment'}
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
