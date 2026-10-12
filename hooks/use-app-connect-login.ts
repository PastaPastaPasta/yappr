'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { appConnectPins } from '@/lib/app-connect/config'
import { AppConnectLogin, parseStoredRequest, type AppConnectLoginState, type RequestRecordStore, type StoredAppConnectRequest } from '@/lib/app-connect/login-flow'
import { appConnectPlatformPort } from '@/lib/app-connect/platform-port'
import { appConnectSessions } from '@/lib/app-connect/session-manager'
import { APP_CONNECT_CHANNEL, isConnectCallbackMessage } from '@/lib/app-connect/callback-channel'

/**
 * The pending request, so a reload or the wallet's return to /connect can
 * resume it (10 minutes at most). Its ephemeral key opens the wallet's answer,
 * so it is wrapped under the key ring's device key, never stored in plain.
 */
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * One slot per kind of request, so a sign-in and a renewal (which names its
 * identity) never overwrite each other's pending request.
 */
function requestRecordsFor(identityHint: string | undefined): RequestRecordStore {
  const secretName = `pending-request:${identityHint ?? 'login'}`
  return {
    async load() {
      const network = appConnectSessions.network()
      try {
        const bytes = await appConnectSessions.keyStore().loadSecret(network, secretName)
        if (!bytes) return null
        let record: StoredAppConnectRequest | null = null
        try {
          record = parseStoredRequest(JSON.parse(decoder.decode(bytes)), Date.now())
        } catch {
          // Unreadable: treated like a stale request below.
        } finally {
          bytes.fill(0)
        }
        // A stale or unreadable request is of no use to anyone: forget it.
        if (!record) await appConnectSessions.keyStore().deleteSecret(network, secretName)
        return record
      } catch (error) {
        logger.warn('App Connect: could not read the pending request:', error)
        return null
      }
    },
    async save(record) {
      const bytes = encoder.encode(JSON.stringify(record))
      try {
        await appConnectSessions.keyStore().saveSecret(appConnectSessions.network(), secretName, bytes)
      } catch (error) {
        // Without storage the request only lives in this tab.
        logger.warn('App Connect: could not keep the pending request:', error)
      } finally {
        bytes.fill(0)
      }
    },
    async clear() {
      await appConnectSessions.keyStore().deleteSecret(appConnectSessions.network(), secretName)
    },
  }
}

/**
 * Runs an App Connect sign-in while mounted: starts (or resumes) a request,
 * polls immediately when the window regains focus or the wallet returns to
 * /connect in another tab, and wipes everything on unmount. `identityHint`
 * makes it a renewal that only that identity may answer.
 */
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
