import { clearSensitiveBytes, getYapprPublicKey, hash160 } from 'platform-auth'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { logger } from '@/lib/logger'
import { scopedKey } from '@/lib/storage-scope'
import { parseStoredRequest, type RequestRecordStore, type StoredAppConnectRequest } from './login-flow'
import { appConnectSessions } from './session-manager'

/**
 * The pending request, so a reload or the wallet's return to /connect can
 * resume it (10 minutes at most). Its ephemeral key opens the wallet's answer,
 * so it is wrapped under the key ring's device key, never stored in plain.
 */
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Record operations run one at a time, in the order they are called, across
 * every tab of this site: a save wraps the key (async crypto) before it
 * writes, and a clear reads the slot before it deletes it, so without this
 * an older request could land last, or one tab could delete a request
 * another tab saved between its read and its delete. Uses a Web Lock where
 * the browser has them, and an in-tab queue otherwise.
 */
const RECORD_LOCK = scopedKey('yappr-app-connect-pending-request')
let recordWrites: Promise<unknown> = Promise.resolve()
function inOrder<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  const locked = async (): Promise<T> => (locks ? await locks.request(RECORD_LOCK, operation) : await operation())
  const run = recordWrites.then(locked, locked)
  recordWrites = run.catch(() => undefined)
  return run
}

/**
 * One slot per kind of request, so a sign-in and a renewal (which names its
 * identity) never overwrite each other's pending request.
 */
export function requestRecordsFor(identityHint: string | undefined): RequestRecordStore {
  const secretName = `pending-request:${identityHint ?? 'login'}`
  return {
    async load() {
      const network = appConnectSessions.network()
      try {
        // Read and (for a stale request) delete under the same lock, so a
        // request another tab saves meanwhile is never the one deleted.
        return await inOrder(async () => {
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
        })
      } catch (error) {
        logger.warn('App Connect: could not read the pending request:', error)
        return null
      }
    },
    async save(record) {
      const bytes = encoder.encode(JSON.stringify(record))
      try {
        await inOrder(() => appConnectSessions.keyStore().saveSecret(appConnectSessions.network(), secretName, bytes))
      } catch (error) {
        // Without storage the request only lives in this tab.
        logger.warn('App Connect: could not keep the pending request:', error)
      } finally {
        bytes.fill(0)
      }
    },
    async clear(record) {
      // Only if it is still ours: another tab may have stored a newer request in this slot.
      await inOrder(async () => {
        const network = appConnectSessions.network()
        const bytes = await appConnectSessions.keyStore().loadSecret(network, secretName)
        if (!bytes) return
        let stored: unknown = null
        try {
          stored = JSON.parse(decoder.decode(bytes))
        } catch {
          // Unreadable: not a request anyone can resume, so it may go.
        } finally {
          bytes.fill(0)
        }
        const storedKey = (stored as { ephemeralPrivateKey?: unknown } | null)?.ephemeralPrivateKey
        if (stored === null || storedKey === record.ephemeralPrivateKey) {
          await appConnectSessions.keyStore().deleteSecret(network, secretName)
        }
      })
    },
  }
}

/**
 * Whether the request the wallet just returned for (its hash, hex) is the
 * pending renewal for `identityId`, so /connect can resume that renewal
 * rather than start a sign-in.
 */
export async function isPendingRenewal(identityId: string, requestHash: string): Promise<boolean> {
  const record = await requestRecordsFor(identityId).load()
  if (!record) return false
  const privateKey = hexToBytes(record.ephemeralPrivateKey)
  try {
    return bytesToHex(hash160(getYapprPublicKey(privateKey))) === requestHash
  } finally {
    clearSensitiveBytes(privateKey)
  }
}
