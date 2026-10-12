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

/** The callback's request hash, or null when the link is not one of ours. */
export function parseConnectCallback(search: string): { requestHash: string; status: string | null } | null {
  const params = new URLSearchParams(search)
  const requestHash = params.get('r')?.toLowerCase() ?? ''
  if (!REQUEST_HASH.test(requestHash)) return null
  const status = params.get('ac')
  return { requestHash, status: status && /^[a-z]{1,16}$/.test(status) ? status : null }
}
