'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { appConnectPins } from '@/lib/app-connect/config'
import { AppConnectLogin, type AppConnectLoginState } from '@/lib/app-connect/login-flow'
import { requestRecordsFor } from '@/lib/app-connect/pending-request'
import { appConnectPlatformPort } from '@/lib/app-connect/platform-port'
import { appConnectSessions } from '@/lib/app-connect/session-manager'
import { APP_CONNECT_CHANNEL, isConnectCallbackMessage } from '@/lib/app-connect/callback-channel'

function createLogin(identityHint: string | undefined): AppConnectLogin | null {
  const pins = appConnectPins()
  if (!pins || typeof window === 'undefined') return null
  return new AppConnectLogin({
    pins,
    network: appConnectSessions.network(),
    port: appConnectPlatformPort,
    // Proved again before every sign-in, so a group widened since page load blocks it.
    trust: () => appConnectSessions.trust({ fresh: true }),
    connectionId: () => appConnectSessions.connectionId(),
    records: requestRecordsFor(identityHint),
    origin: window.location.origin,
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
    onError: (message, error) => logger.warn(message, error),
  })
}

/**
 * Runs an App Connect sign-in while mounted: starts (or resumes) a request,
 * polls immediately when the window regains focus or the wallet returns to
 * /connect in another tab, and wipes everything on unmount. `identityHint`
 * makes it a renewal that only that identity may answer.
 */
export function useAppConnectLogin(identityHint?: string): { login: AppConnectLogin | null; state: AppConnectLoginState } {
  // One instance per mount: a disposed instance never restarts, so React's
  // dev double-mount and a changed hint each get a fresh one.
  const [login, setLogin] = useState<AppConnectLogin | null>(null)
  const [state, setState] = useState<AppConnectLoginState>(() =>
    appConnectPins() ? { phase: 'checking' } : { phase: 'unavailable', reason: 'not-configured' })

  useEffect(() => {
    const instance = createLogin(identityHint)
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
  }, [identityHint])

  return { login, state }
}
