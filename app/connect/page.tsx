'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import {
  APP_CONNECT_CHANNEL,
  isConnectCallbackAck,
  parseConnectCallback,
  type ConnectCallbackMessage,
} from '@/lib/app-connect/callback-channel'

/** How long to wait for the tab showing the QR code to answer before signing in here. */
const ACK_WAIT_MS = 1_500

const STATUS_COPY: Record<string, { title: string; description: string }> = {
  declined: { title: 'Sign-in declined', description: 'You declined the sign-in in your wallet.' },
  stale: { title: 'That code expired', description: 'Start again from Yappr for a fresh one.' },
  unsupported: { title: 'Your wallet can\'t sign in to Yappr yet', description: 'Update your Dash wallet, then try again.' },
  invalid: { title: 'Your wallet couldn\'t sign you in', description: 'Try again from Yappr with a fresh code.' },
  failed: { title: 'Your wallet couldn\'t sign you in', description: 'Try again from Yappr with a fresh code.' },
}

type View = { kind: 'waiting' } | { kind: 'other-tab' } | { kind: 'status'; title: string; description: string }

/**
 * Where a wallet returns after an App Connect sign-in (`cb` in the request).
 * It is only a nudge: it tells the tab showing the QR code to check now, and
 * if no tab answers it opens sign-in here, which picks up the same request.
 * Nothing on this page is trusted; the poll and the on-chain checks decide.
 */
export default function ConnectPage() {
  const router = useRouter()
  const [view, setView] = useState<View>({ kind: 'waiting' })

  useEffect(() => {
    const callback = parseConnectCallback(window.location.search)
    if (!callback) {
      router.replace('/')
      return
    }
    const failure = callback.status && callback.status !== 'ok' ? STATUS_COPY[callback.status] : undefined
    if (failure) {
      setView({ kind: 'status', ...failure })
      return
    }
    if (typeof BroadcastChannel === 'undefined') {
      router.replace('/login/')
      return
    }

    const channel = new BroadcastChannel(APP_CONNECT_CHANNEL)
    let answered = false
    channel.onmessage = (event: MessageEvent) => {
      if (!isConnectCallbackAck(event.data, callback.requestHash)) return
      answered = true
      setView({ kind: 'other-tab' })
    }
    const message: ConnectCallbackMessage = { type: 'app-connect-callback', requestHash: callback.requestHash, status: callback.status }
    channel.postMessage(message)
    const timer = setTimeout(() => {
      if (!answered) router.replace('/login/')
    }, ACK_WAIT_MS)
    return () => {
      clearTimeout(timer)
      channel.close()
    }
  }, [router])

  return (
    <div className="min-h-[calc(100vh-104px)] md:min-h-[calc(100vh-40px)] flex items-center justify-center px-4">
      <div className="max-w-sm text-center flex flex-col items-center gap-4" role="status" aria-live="polite">
        {view.kind === 'waiting' && (
          <>
            <Spinner size="lg" />
            <p className="text-sm text-gray-600 dark:text-gray-400">Finishing sign-in</p>
          </>
        )}
        {view.kind === 'other-tab' && (
          <>
            <p className="font-medium text-gray-900 dark:text-white">You&apos;re signing in on your other Yappr tab</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">You can close this one.</p>
          </>
        )}
        {view.kind === 'status' && (
          <>
            <p className="font-medium text-gray-900 dark:text-white">{view.title}</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">{view.description}</p>
            <Button asChild>
              <Link href="/login/">Back to Yappr</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
