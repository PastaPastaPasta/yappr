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
/** The identity of the latest signed-out passkey renewal, whose request stays in that identity's own slot. */
const RECOVERY_POINTER = 'pending-request:recovery'
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
 * identity) never overwrite each other's pending request. A signed-out
 * passkey's renewal (`recovery`) also points the wallet's callback tab, which
 * does not know the identity, at its slot.
 */
export function requestRecordsFor(identityHint: string | undefined, recovery = false): RequestRecordStore & {
  /** As `load`, but a failed read or unwrap throws rather than reading as no request. */
  loadStrict(): Promise<StoredAppConnectRequest | null>
} {
  const secretName = `pending-request:${identityHint ?? 'login'}`
  // Read and (for a stale request) delete under the same lock, so a
  // request another tab saves meanwhile is never the one deleted.
  const read = (strict: boolean) => inOrder(async () => {
    const network = appConnectSessions.network()
    const bytes = await appConnectSessions.keyStore().loadSecret(network, secretName, { strict })
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
  return {
    async load() {
      try {
        return await read(false)
      } catch (error) {
        logger.warn('App Connect: could not read the pending request:', error)
        return null
      }
    },
    loadStrict: () => read(true),
    async save(record) {
      const bytes = encoder.encode(JSON.stringify(record))
      try {
        await inOrder(async () => {
          const network = appConnectSessions.network()
          await appConnectSessions.keyStore().saveSecret(network, secretName, bytes)
          if (recovery && identityHint) await appConnectSessions.keyStore().saveSecret(network, RECOVERY_POINTER, encoder.encode(identityHint))
        })
      } catch (error) {
        // Without storage the request only lives in this tab.
        logger.warn('App Connect: could not keep the pending request:', error)
      } finally {
        bytes.fill(0)
      }
    },
    async clear(record) {
      // Only if it is still ours: another tab may have stored a newer request in this slot.
      await inOrder(() => appConnectSessions.keyStore().deleteSecretIf(appConnectSessions.network(), secretName, (bytes) => {
        let stored: unknown = null
        try {
          stored = JSON.parse(decoder.decode(bytes))
        } catch {
          // Unreadable: not a request anyone can resume, so it may go.
        }
        return stored === null || (stored as { ephemeralPrivateKey?: unknown }).ephemeralPrivateKey === record.ephemeralPrivateKey
      }))
    },
    take(record) {
      return inOrder(async () => {
        let ours = false
        const deleted = await appConnectSessions.keyStore().deleteSecretIf(appConnectSessions.network(), secretName, (bytes) => {
          let stored: StoredAppConnectRequest | null = null
          try {
            stored = parseStoredRequest(JSON.parse(decoder.decode(bytes)), Date.now())
          } catch {
            // Unreadable: not this request.
          }
          ours = stored?.ephemeralPrivateKey === record.ephemeralPrivateKey
          // Ours, or stale or unreadable: either way of no use to anyone now.
          return ours || !stored
        })
        return ours && deleted
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
  return record !== null && hasRequestHash(record, requestHash)
}

/**
 * The identity of the latest signed-out passkey renewal, when its request is
 * still the one the wallet returned for. A newer renewal for another identity
 * only moves the pointer: this one then reads as none, and its request stays.
 */
export async function pendingRecoveryIdentity(requestHash: string): Promise<string | null> {
  const bytes = await appConnectSessions.keyStore().loadSecret(appConnectSessions.network(), RECOVERY_POINTER).catch(() => null)
  if (!bytes) return null
  const identityId = decoder.decode(bytes)
  return identityId && await isPendingRenewal(identityId, requestHash) ? identityId : null
}

function hasRequestHash(record: StoredAppConnectRequest, requestHash: string): boolean {
  const privateKey = hexToBytes(record.ephemeralPrivateKey)
  try {
    return bytesToHex(hash160(getYapprPublicKey(privateKey))) === requestHash
  } finally {
    clearSensitiveBytes(privateKey)
  }
}
