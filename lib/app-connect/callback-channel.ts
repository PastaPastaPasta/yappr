import { scopedKey } from '@/lib/storage-scope'

/**
 * The wallet returns to `/connect?r=<request hash>&ac=<status>` (possibly in a
 * new tab). That page tells the tab showing the QR code over this channel, and
 * that tab polls at once. The message is only a nudge: nothing is trusted from
 * it, the poll and the verifier decide.
 */
export const APP_CONNECT_CHANNEL = scopedKey('yappr-app-connect')

export interface ConnectCallbackMessage {
  type: 'app-connect-callback'
  requestHash: string
  status: string | null
}

export interface ConnectCallbackAck {
  type: 'app-connect-callback-ack'
  requestHash: string
}

const REQUEST_HASH = /^[0-9a-f]{40}$/

export function isConnectCallbackMessage(value: unknown): value is ConnectCallbackMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.type === 'app-connect-callback'
    && typeof message.requestHash === 'string' && REQUEST_HASH.test(message.requestHash)
}

export function isConnectCallbackAck(value: unknown, requestHash: string): value is ConnectCallbackAck {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.type === 'app-connect-callback-ack' && message.requestHash === requestHash
}

/**
 * The Yappr apps' URL schemes (mobile/app/src/variants.ts). A sign-in made in
 * an app asks the wallet to return here with `app=<scheme>`, and this page
 * hands the user back to that app; any other value is ignored, so the page
 * never opens a scheme it does not know.
 */
export const YAPPR_APP_SCHEMES = ['yappr-dev', 'yappr-beta', 'yappr'] as const
export type YapprAppScheme = (typeof YAPPR_APP_SCHEMES)[number]

const isAppScheme = (value: string | null): value is YapprAppScheme =>
  value !== null && (YAPPR_APP_SCHEMES as readonly string[]).includes(value)

export interface ConnectCallback {
  requestHash: string
  status: string | null
  /** The Yappr app that made the request, when it was one. */
  app: YapprAppScheme | null
}

/** The callback's request hash, or null when the link is not one of ours. */
export function parseConnectCallback(search: string): ConnectCallback | null {
  const params = new URLSearchParams(search)
  const requestHash = params.get('r')?.toLowerCase() ?? ''
  if (!REQUEST_HASH.test(requestHash)) return null
  const status = params.get('ac')
  const app = params.get('app')
  return {
    requestHash,
    status: status && /^[a-z]{1,16}$/.test(status) ? status : null,
    app: isAppScheme(app) ? app : null,
  }
}

/**
 * The link that hands the user back to the app that made the request: only
 * the request hash and the wallet's status, the same reference the wallet
 * already passed in the clear. The app treats it as a nudge to check.
 */
export function appReturnLink(callback: ConnectCallback & { app: YapprAppScheme }): string {
  const status = callback.status ? `&ac=${callback.status}` : ''
  return `${callback.app}://connect?r=${callback.requestHash}${status}`
}
