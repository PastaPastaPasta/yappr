'use client'

import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { ClipboardIcon, CheckIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface KeyExchangeQRProps {
  /** The dash-key: or dash-st: URI to display */
  uri: string
  /** Size of the QR code in pixels (default: 200) */
  size?: number
  /** Remaining time in seconds (optional) */
  remainingTime?: number | null
}

/**
 * QR code component for key exchange URI.
 *
 * Displays a dash-key:/dash-st: URI as a QR code that can be scanned by a
 * wallet app. On touch devices (where scanning your own screen is impossible)
 * it also offers an "Open in wallet app" deep link into a wallet registered
 * for the URI scheme. Includes copy-to-clipboard functionality for manual entry.
 */
export function KeyExchangeQR({
  uri,
  size = 200,
  remainingTime
}: KeyExchangeQRProps) {
  const [copied, setCopied] = useState(false)
  const [isTouchDevice, setIsTouchDevice] = useState(false)

  // Coarse-pointer detection has to run client-side; the static export renders
  // the desktop (QR-first) layout until hydration.
  useEffect(() => {
    setIsTouchDevice(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(uri)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS) — no success indicator shown
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
      {/* Deep link for wallets installed on this device */}
      {isTouchDevice && (
        <a
          href={uri}
          className={cn(buttonVariants({ size: 'lg' }), 'w-full gap-2')}
        >
          <ArrowTopRightOnSquareIcon className="w-5 h-5" />
          Open in Wallet App
        </a>
      )}

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
          {isTouchDevice
            ? 'Open in a wallet app on this device, or scan the QR code with a wallet on another device'
            : 'Scan with a compatible Dash wallet, such as Dash Evo Tool'}
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
