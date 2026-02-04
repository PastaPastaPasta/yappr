'use client'

import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { ClipboardIcon, CheckIcon } from '@heroicons/react/24/outline'

interface KeyExchangeQRProps {
  /** The dash-key: URI to display */
  uri: string
  /** Size of the QR code in pixels (default: 200) */
  size?: number
  /** Remaining time in seconds (optional) */
  remainingTime?: number | null
}

/**
 * QR code component for key exchange URI.
 *
 * Displays a dash-key: URI as a QR code that can be scanned by a wallet app.
 * Includes copy-to-clipboard functionality for manual entry.
 */
export function KeyExchangeQR({
  uri,
  size = 200,
  remainingTime
}: KeyExchangeQRProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(uri)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = uri
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Format remaining time as MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="flex flex-col items-center gap-4">
      {/* QR Code */}
      <div className="p-4 bg-white rounded-xl shadow-sm border-2 border-blue-500">
        <QRCodeSVG
          value={uri}
          size={size}
          level="M"
          includeMargin={false}
          fgColor="#000000"
          bgColor="#FFFFFF"
        />
      </div>

      {/* Instructions */}
      <div className="text-center">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Scan with Dash Evo Tool or compatible wallet
        </p>
        {remainingTime !== null && remainingTime !== undefined && (
          <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
            Expires in {formatTime(remainingTime)}
          </p>
        )}
      </div>

      {/* Copy button */}
      <button
        onClick={handleCopy}
        className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors"
      >
        {copied ? (
          <>
            <CheckIcon className="w-4 h-4 text-green-500" />
            <span className="text-green-600 dark:text-green-400">Copied!</span>
          </>
        ) : (
          <>
            <ClipboardIcon className="w-4 h-4" />
            <span>Copy URI</span>
          </>
        )}
      </button>
    </div>
  )
}
