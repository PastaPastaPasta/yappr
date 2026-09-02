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
}

/**
 * QR code component for key exchange URI.
 *
 * Displays a dash-key:/dash-st: URI as a QR code that can be scanned by a
 * wallet app. On touch devices (where scanning your own screen is impossible)
 * it also offers an "Open in wallet app" deep link into a wallet registered
 * for the URI scheme. Includes copy-to-clipboard functionality for manual entry.
 *
 * Deliberately shows no countdown: the request's lifetime is an internal
 * polling budget, and surfacing it made users wonder what happens at zero.
 * Callers render their own "check again" state when the request expires.
 */
export function KeyExchangeQR({ uri, size = 200 }: KeyExchangeQRProps) {
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

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Deep link for wallets installed on this device */}
      {isTouchDevice && (
        <a
          href={uri}
          className={cn(buttonVariants({ size: 'lg' }), 'w-full gap-2')}
        >
          <ArrowTopRightOnSquareIcon className="w-5 h-5" />
          Open in wallet app
        </a>
      )}

      {/* QR tile */}
      <div className="p-4 bg-white rounded-2xl ring-1 ring-gray-200 dark:ring-neutral-700 shadow-sm">
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
      <p className="text-sm text-center text-gray-600 dark:text-gray-400 max-w-xs">
        {isTouchDevice
          ? 'Open in a wallet on this device, or scan with a wallet on another device'
          : 'Scan with a Dash wallet such as Dash Evo Tool'}
      </p>

      {/* Copy button */}
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500"
      >
        {copied ? (
          <>
            <CheckIcon className="w-4 h-4 text-green-500" />
            <span className="text-green-600 dark:text-green-400">Copied</span>
          </>
        ) : (
          <>
            <ClipboardIcon className="w-4 h-4" />
            <span>Copy link</span>
          </>
        )}
      </button>
    </div>
  )
}
