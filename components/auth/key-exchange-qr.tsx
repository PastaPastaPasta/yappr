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
 * wallet app, and offers an "Open in wallet app" deep link into whichever
 * wallet is registered for the URI scheme on this device. The deep link
 * matters on desktop too: Dash Evo Tool runs on the same machine as the
 * browser, so scanning is a detour. Browsers give no signal when no handler is
 * registered, so a fallback hint appears once the link has been clicked.
 * Copy-to-clipboard is the manual fallback. Desktop always shows it; a touch
 * device shows it only after a launch attempt, because there the deep link
 * normally hands the URI over, and a phone cannot scan its own screen.
 *
 * Deliberately shows no countdown: the request's lifetime is an internal
 * polling budget, and surfacing it made users wonder what happens at zero.
 * Callers render their own "check again" state when the request expires.
 */
export function KeyExchangeQR({ uri, size = 200 }: KeyExchangeQRProps) {
  const [copied, setCopied] = useState(false)
  const [isTouchDevice, setIsTouchDevice] = useState(false)
  const [launchAttempted, setLaunchAttempted] = useState(false)

  // Coarse-pointer detection has to run client-side; the static export renders
  // the desktop copy until hydration.
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

  return (
    <div className="flex flex-col items-center gap-4">
      {/* Deep link into a wallet registered for the scheme on this device */}
      <a
        href={uri}
        onClick={() => setLaunchAttempted(true)}
        className={cn(buttonVariants({ size: 'lg' }), 'w-full gap-2')}
      >
        <ArrowTopRightOnSquareIcon className="w-5 h-5" />
        Open in wallet app
      </a>

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
          : 'Open your wallet on this computer, or scan with your phone'}
      </p>

      {/* Copy button: on touch, only once the deep link may have failed */}
      {(!isTouchDevice || launchAttempted) && (
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
      )}

      {/* Browsers stay silent when no app handles the scheme, so say what to do */}
      {launchAttempted && (
        <p className="text-xs text-center text-gray-500 dark:text-gray-400 max-w-xs">
          {isTouchDevice
            ? 'Nothing opened? No wallet app on this device handles Dash links. Scan the QR code with a wallet on another device, or copy the link into your wallet.'
            : 'Nothing opened? No wallet on this computer handles Dash links. Scan the QR code with your phone, or copy the link into your wallet.'}
        </p>
      )}
    </div>
  )
}
