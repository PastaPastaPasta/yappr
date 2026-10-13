'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useRenewModal } from '@/hooks/use-renew-modal'
import { isPendingRenewal } from '@/lib/app-connect/pending-request'
import {
  APP_CONNECT_CHANNEL,
  appReturnLink,
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

type View =
  | { kind: 'waiting' }
  | { kind: 'other-tab' }
  | { kind: 'status'; title: string; description: string }
  /** The request came from the Yappr app: hand the user back to it. */
  | { kind: 'app'; link: string }

/**
 * Where a wallet returns after an App Connect sign-in (`cb` in the request).
 * It is only a nudge: it tells the tab showing the QR code to check now, and
 * if no tab answers it opens sign-in here, which picks up the same request.
 * A request the Yappr app made (`app=<scheme>`, a known scheme only) goes back
 * to the app instead, which checks at once. Nothing on this page is trusted;
 * the poll and the on-chain checks decide.
 */
export default function ConnectPage() {
  const router = useRouter()
  const { user, isAuthRestoring } = useAuth()
  const [view, setView] = useState<View>({ kind: 'waiting' })
  /** No other tab took the request: continue here once we know who is signed in. */
  const [continueHere, setContinueHere] = useState<string | null>(null)

  useEffect(() => {
    if (!continueHere || isAuthRestoring) return
    const requestHash = continueHere
    const identityId = user?.identityId
    // A renewal of the signed-in account resumes in its renew dialog; anything else is a sign-in.
    const pendingRenewal = identityId ? isPendingRenewal(identityId, requestHash) : Promise.resolve(false)
    pendingRenewal
      .catch(() => false)
      .then((renewal) => {
        if (renewal) {
          useRenewModal.getState().open()
          router.replace('/feed/')
        } else {
          router.replace('/login/')
        }
      })
      .catch(() => router.replace('/login/'))
  }, [continueHere, isAuthRestoring, router, user?.identityId])

  useEffect(() => {
    const callback = parseConnectCallback(window.location.search)
    if (!callback) {
      router.replace('/')
      return
    }
    // The app shows what the wallet reported, so every status goes back to it.
    if (callback.app) {
      const link = appReturnLink({ ...callback, app: callback.app })
      setView({ kind: 'app', link })
      window.location.replace(link)
      return
    }
    const failure = callback.status && callback.status !== 'ok' ? STATUS_COPY[callback.status] : undefined
    if (failure) {
      setView({ kind: 'status', ...failure })
      return
    }
    if (typeof BroadcastChannel === 'undefined') {
      setContinueHere(callback.requestHash)
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
      if (!answered) setContinueHere(callback.requestHash)
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
        {view.kind === 'app' && (
          <>
            <p className="font-medium text-gray-900 dark:text-white">Back to the Yappr app</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">If it didn&apos;t open, tap below.</p>
            <Button asChild>
              <a href={view.link}>Open Yappr</a>
            </Button>
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
