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
 * wallet app, and offers an "Open Dash Wallet" deep link into whichever wallet
 * is registered for the URI scheme on this device. The deep link matters on
 * desktop too — Dash Evo Tool runs on the same machine as the browser, so
 * scanning is a detour — but the browser gives no signal when no handler is
 * registered, so a fallback hint appears once the link has been clicked.
 * Includes copy-to-clipboard functionality for manual entry.
 */
export function KeyExchangeQR({
  uri,
  size = 200,
  remainingTime
}: KeyExchangeQRProps) {
  const [copied, setCopied] = useState(false)
  const [isTouchDevice, setIsTouchDevice] = useState(false)
  const [launchAttempted, setLaunchAttempted] = useState(false)

  // Coarse-pointer detection has to run client-side; the static export renders
  // the desktop wording until hydration.
  useEffect(() => {
    setIsTouchDevice(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  // A new request (retry, or expiry-driven regeneration) starts a fresh attempt
  useEffect(() => {
    setLaunchAttempted(false)
  }, [uri])

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
      {/* Deep link into a wallet registered for the scheme on this device */}
      <a
        href={uri}
        onClick={() => setLaunchAttempted(true)}
        className={cn(buttonVariants({ size: 'lg' }), 'w-full gap-2')}
      >
        <ArrowTopRightOnSquareIcon className="w-5 h-5" />
        Open Dash Wallet
      </a>

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
            ? 'Open a wallet app on this device, or scan the QR code with a wallet on another device'
            : 'Open a wallet on this computer, such as Dash Evo Tool, or scan the QR code with a wallet on your phone'}
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

      {/* Browsers stay silent when no app handles the scheme, so say what to do */}
      {launchAttempted && (
        <p className="text-xs text-center text-gray-500 dark:text-gray-500">
          Nothing opened? No wallet on this device is registered to handle Dash
          login links. Scan the QR code with a wallet on another device, or copy
          the URI and paste it into your wallet.
        </p>
      )}
    </div>
  )
}
