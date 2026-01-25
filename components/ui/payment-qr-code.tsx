'use client'

import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { ClipboardIcon, CheckIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'
import { PaymentSchemeIcon, getPaymentLabel, PAYMENT_SCHEME_LABELS } from './payment-icons'
import { DashPaymentWatcher } from './dash-payment-watcher'
import type { ParsedPaymentUri } from '@/lib/types'

// Get scheme color for QR code styling
const PAYMENT_COLORS: Record<string, string> = {
  'dash:': '#008DE4',
  'tdash:': '#008DE4',
  'bitcoin:': '#F7931A',
  'litecoin:': '#345D9D',
  'ethereum:': '#627EEA',
  'monero:': '#FF6600',
  'dogecoin:': '#C2A633',
  'bitcoincash:': '#0AC18E',
  'zcash:': '#ECB244',
  'stellar:': '#000000',
  'ripple:': '#23292F',
  'solana:': '#9945FF',
  'cardano:': '#0033AD',
  'polkadot:': '#E6007A',
  'tron:': '#FF0013',
  'lightning:': '#F7931A',
}

interface PaymentQRCodeProps {
  paymentUri: ParsedPaymentUri
  onBack?: () => void
  size?: number
  watchForTransaction?: boolean
  onTransactionDetected?: (txid: string, amountDash: number) => void
  onWatchTimeout?: () => void
  onDone?: () => void
}

export function PaymentQRCode({
  paymentUri,
  onBack,
  size = 200,
  watchForTransaction = false,
  onTransactionDetected,
  onWatchTimeout,
  onDone
}: PaymentQRCodeProps) {
  const [copied, setCopied] = useState(false)

  const schemeColor = PAYMENT_COLORS[paymentUri.scheme.toLowerCase()] || '#6B7280'
  const label = PAYMENT_SCHEME_LABELS[paymentUri.scheme.toLowerCase()] || getPaymentLabel(paymentUri.uri)

  // Extract just the address (without scheme prefix)
  const address = paymentUri.uri.includes(':')
    ? paymentUri.uri.split(':')[1].split('?')[0]
    : paymentUri.uri

  // Enable watching if requested (DashPaymentWatcher handles scheme check internally)
  const shouldWatch = watchForTransaction

  const handleCopy = async () => {
    try {
      // Copy just the address, not the full URI scheme
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = address
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleOpenWallet = () => {
    window.open(paymentUri.uri, '_blank')
  }

  return (
    <div className="space-y-4">
      {/* Header with back button */}
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          <ArrowLeftIcon className="w-4 h-4" />
          Back to payment options
        </button>
      )}

      {/* Payment method header */}
      <div className="flex items-center gap-3">
        <PaymentSchemeIcon scheme={paymentUri.scheme} size="lg" />
        <div>
          <h3 className="font-semibold text-lg">{label}</h3>
          <p className="text-sm text-gray-500">Scan to send payment</p>
        </div>
      </div>

      {/* QR Code */}
      <div className="flex justify-center">
        <div
          className="p-4 bg-white rounded-xl shadow-sm"
          style={{ border: `3px solid ${schemeColor}` }}
        >
          <QRCodeSVG
            value={paymentUri.uri}
            size={size}
            level="M"
            includeMargin={false}
            fgColor="#000000"
            bgColor="#FFFFFF"
          />
        </div>
      </div>

      {/* Address display */}
      <div className="bg-gray-50 dark:bg-neutral-800 rounded-lg p-3 space-y-2">
        <p className="text-xs text-gray-500 font-medium">Address</p>
        <p className="font-mono text-sm break-all text-gray-900 dark:text-gray-100">
          {address}
        </p>
      </div>

      {/* Transaction watcher for Dash payments */}
      {shouldWatch && (
        <DashPaymentWatcher
          scheme={paymentUri.scheme}
          address={address}
          enabled={true}
          onDetected={onTransactionDetected}
          onTimeout={onWatchTimeout}
          onDone={onDone}
        />
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleCopy}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors"
        >
          {copied ? (
            <>
              <CheckIcon className="w-4 h-4 text-green-500" />
              <span className="text-green-600 dark:text-green-400">Copied!</span>
            </>
          ) : (
            <>
              <ClipboardIcon className="w-4 h-4" />
              <span>Copy Address</span>
            </>
          )}
        </button>
        <button
          onClick={handleOpenWallet}
          className="flex-1 px-4 py-2.5 rounded-lg text-white transition-colors"
          style={{ backgroundColor: schemeColor }}
        >
          Open in Wallet
        </button>
      </div>

      <p className="text-xs text-gray-500 text-center">
        Or use the button above to open in your wallet app
      </p>
    </div>
  )
}
