'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { appConnectPins } from '@/lib/app-connect/config'
import { AppConnectLogin, type AppConnectLoginState } from '@/lib/app-connect/login-flow'
import { requestRecordsFor } from '@/lib/app-connect/pending-request'
import { appConnectPlatformPort } from '@/lib/app-connect/platform-port'
import { appConnectSessions } from '@/lib/app-connect/session-manager'
import { APP_CONNECT_CHANNEL, CALLBACK_REQUEST_PARAM, callbackRequestHash, isConnectCallbackMessage } from '@/lib/app-connect/callback-channel'
import { onLoginPage, onUsernameDetour, signInReturnRoute } from '@/lib/auth/return-to'

/** The callback tab's sign-in now names `requestHash`, a replacement it made, so a reload keeps its page. */
function nameCallbackRequest(requestHash: string): void {
  if (!onLoginPage()) return
  const url = new URL(window.location.href)
  url.searchParams.set(CALLBACK_REQUEST_PARAM, requestHash)
  window.history.replaceState(window.history.state, '', url)
}

function createLogin(identityHint: string | undefined, recovery: boolean): AppConnectLogin | null {
  const pins = appConnectPins()
  if (!pins || typeof window === 'undefined') return null
  const signsIn = !identityHint || recovery
  return new AppConnectLogin({
    pins,
    network: appConnectSessions.network(),
    port: appConnectPlatformPort,
    // Proved again before every sign-in, so a group widened since page load blocks it.
    trust: () => appConnectSessions.trust({ fresh: true }),
    connectionId: () => appConnectSessions.connectionId(),
    records: requestRecordsFor(identityHint, recovery),
    // A sign-in request carries the page it started on, and the username step it started on, for the wallet's callback tab.
    returnTo: signsIn ? signInReturnRoute() ?? undefined : undefined,
    registerUsername: signsIn && onUsernameDetour(),
    callbackRequestHash: onLoginPage() ? callbackRequestHash(window.location.search) : undefined,
    onCarry: nameCallbackRequest,
    origin: window.location.origin,
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
    onError: (message, error) => logger.warn(message, error),
  })
}

/**
 * Runs an App Connect sign-in while mounted: starts (or resumes) a request,
 * polls immediately when the window regains focus or the wallet returns to
 * /connect in another tab, and wipes everything on unmount. `identityHint`
 * makes it a renewal that only that identity may answer; `recovery`, a signed-out
 * passkey's renewal, which signs in and so carries its page like a sign-in.
 */
export function useAppConnectLogin(identityHint?: string, recovery = false): { login: AppConnectLogin | null; state: AppConnectLoginState } {
  // One instance per mount: a disposed instance never restarts, so React's
  // dev double-mount and a changed hint each get a fresh one.
  const [login, setLogin] = useState<AppConnectLogin | null>(null)
  const [state, setState] = useState<AppConnectLoginState>(() =>
    appConnectPins() ? { phase: 'checking' } : { phase: 'unavailable', reason: 'not-configured' })

  useEffect(() => {
    const instance = createLogin(identityHint, recovery)
    if (!instance) return
    setLogin(instance)
    const unsubscribe = instance.subscribe(setState)
    instance.start({ identityHint }).catch((error: unknown) => logger.error('App Connect: sign-in failed to start', error))

    const onFocus = () => instance.pollNow()
    window.addEventListener('focus', onFocus)
    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(APP_CONNECT_CHANNEL)
      channel.onmessage = (event: MessageEvent) => {
        if (!isConnectCallbackMessage(event.data) || event.data.requestHash !== instance.requestHashHex()) return
        channel?.postMessage({ type: 'app-connect-callback-ack', requestHash: event.data.requestHash })
        instance.pollNow()
      }
    }
    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
      channel?.close()
      instance.dispose()
      setLogin((current) => (current === instance ? null : current))
    }
  }, [identityHint, recovery])

  return { login, state }
}
