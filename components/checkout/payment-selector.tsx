'use client'

import { useState, useCallback } from 'react'
import { CreditCardIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import { Button } from '@/components/ui/button'
import { PaymentQRCode } from '@/components/ui/payment-qr-code'
import { isDashScheme } from '@/lib/services/insight-api-service'
import type { ParsedPaymentUri } from '@/lib/types'

interface PaymentSelectorProps {
  paymentUris: ParsedPaymentUri[]
  selected: ParsedPaymentUri | null
  onSelect: (uri: ParsedPaymentUri | null) => void
  txid: string
  onTxidChange: (txid: string) => void
  onSubmit: () => void
  orderTotal?: number
  orderCurrency?: string
}

export function PaymentSelector({
  paymentUris,
  selected,
  onSelect,
  txid,
  onTxidChange,
  onSubmit,
  orderTotal,
  orderCurrency
}: PaymentSelectorProps) {
  const [detectedAmount, setDetectedAmount] = useState<number | null>(null)
  const [wasAutoFilled, setWasAutoFilled] = useState(false)

  // Check if the selected payment is a Dash scheme
  const isSelectedDashPayment = selected && isDashScheme(selected.scheme)

  // Handle detected Dash transaction
  const handleTransactionDetected = useCallback((detectedTxid: string, amountDash: number) => {
    onTxidChange(detectedTxid)
    setDetectedAmount(amountDash)
    setWasAutoFilled(true)
  }, [onTxidChange])

  // Handle payment selection - reset detected state when changing payment
  const handleSelect = useCallback((uri: ParsedPaymentUri | null) => {
    onSelect(uri)
    onTxidChange('') // Clear any stale txid from previous payment method
    setDetectedAmount(null)
    setWasAutoFilled(false)
  }, [onSelect, onTxidChange])

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 text-lg font-medium">
        <CreditCardIcon className="h-5 w-5 text-yappr-500" />
        Payment
      </div>

      {paymentUris.length > 0 ? (
        <div className="space-y-3">
          {paymentUris.map((uri, i) => (
            <button
              key={i}
              onClick={() => handleSelect(uri)}
              className={`w-full p-4 border rounded-lg text-left transition-colors ${
                selected?.uri === uri.uri
                  ? 'border-yappr-500 bg-yappr-50 dark:bg-yappr-900/20'
                  : 'border-surface-200 dark:border-surface-700 hover:border-surface-200'
              }`}
            >
              <p className="font-medium">{uri.label || uri.scheme.replace(':', '')}</p>
              <p className="text-sm text-gray-500 font-mono truncate">{uri.uri}</p>
            </button>
          ))}
        </div>
      ) : (
        <div className="p-4 border border-yellow-200 bg-yellow-50 rounded-lg text-yellow-700">
          This store has not configured payment methods.
        </div>
      )}

      {selected && (
        <div className="border-t border-surface-200 dark:border-surface-800 pt-4 space-y-4">
          <PaymentQRCode
            paymentUri={selected}
            onBack={() => handleSelect(null)}
            size={180}
            watchForTransaction={!!isSelectedDashPayment}
            onTransactionDetected={handleTransactionDetected}
            orderTotal={orderTotal}
            orderCurrency={orderCurrency}
          />

          <div>
            <label className="block text-sm font-medium mb-1 flex items-center gap-2">
              Transaction ID (optional)
              {wasAutoFilled && (
                <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <CheckCircleIcon className="w-3.5 h-3.5" />
                  Auto-detected
                </span>
              )}
            </label>
            <input
              type="text"
              value={txid}
              onChange={(e) => {
                onTxidChange(e.target.value)
                // If user manually edits, clear the auto-fill indicator
                if (wasAutoFilled) setWasAutoFilled(false)
              }}
              placeholder={isSelectedDashPayment ? "Will auto-fill when detected" : "Enter after payment"}
              className={`w-full px-4 py-2 border rounded-lg bg-white dark:bg-surface-900 focus:outline-none focus:ring-2 focus:ring-yappr-500 font-mono text-sm ${
                wasAutoFilled
                  ? 'border-green-300 dark:border-green-700'
                  : 'border-surface-200 dark:border-surface-700'
              }`}
            />
            {detectedAmount !== null && wasAutoFilled && (
              <p className="text-xs text-green-600 dark:text-green-400 mt-1">
                Detected payment: {detectedAmount.toFixed(8)} DASH
              </p>
            )}
            {!wasAutoFilled && (
              <p className="text-xs text-gray-500 mt-1">
                {isSelectedDashPayment
                  ? 'Transaction will be auto-detected when you send payment'
                  : 'You can add this after placing your order'}
              </p>
            )}
          </div>
        </div>
      )}

      <Button
        className="w-full"
        onClick={onSubmit}
        disabled={!selected}
      >
        Review Order
      </Button>
    </div>
  )
}
