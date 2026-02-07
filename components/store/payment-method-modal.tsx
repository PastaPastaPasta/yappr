'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { XMarkIcon, WalletIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { PaymentSchemeIcon } from '@/components/ui/payment-icons'

// Supported payment schemes with their details
const PAYMENT_SCHEMES = [
  { scheme: 'tdash:', label: 'Dash (Testnet)', placeholder: 'yxxxxxxxxxxxxxxxxxxxxxxxxYYYYYY', hint: 'Your testnet Dash wallet address' },
  { scheme: 'dash:', label: 'Dash', placeholder: 'XxxxxxxxxxxxxxxxxxxxxxxxxYYYYYY', hint: 'Your Dash wallet address' },
  { scheme: 'bitcoin:', label: 'Bitcoin', placeholder: 'bc1qxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Bitcoin wallet address' },
  { scheme: 'ethereum:', label: 'Ethereum', placeholder: '0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Ethereum wallet address' },
  { scheme: 'litecoin:', label: 'Litecoin', placeholder: 'ltc1qxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Litecoin wallet address' },
  { scheme: 'monero:', label: 'Monero', placeholder: '4xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Monero wallet address' },
  { scheme: 'dogecoin:', label: 'Dogecoin', placeholder: 'Dxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Dogecoin wallet address' },
  { scheme: 'solana:', label: 'Solana', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', hint: 'Your Solana wallet address' },
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

  if (!isOpen) return null

  const selectedScheme = PAYMENT_SCHEMES.find(s => s.scheme === scheme) || PAYMENT_SCHEMES[0]

  const handleSubmit = async () => {
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
        className="relative w-full max-w-md bg-white dark:bg-gray-900 rounded-2xl shadow-xl"
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
            disabled={isSubmitting || !address.trim()}
          >
            {isSubmitting ? 'Adding...' : 'Add Payment'}
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
