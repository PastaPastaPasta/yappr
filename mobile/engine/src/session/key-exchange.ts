import {
  buildYapprKeyExchangeUri,
  buildYapprStateTransitionUri,
  DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG,
  clearSensitiveBytes,
  decodeYapprContractId,
  decodeYapprIdentityId,
  deriveYapprAuthKeyFromLogin,
  deriveYapprEncryptionKeyFromLogin,
  generateYapprEphemeralKeyPair,
  getYapprPublicKey,
  hash160,
  type PlatformAuthController,
} from 'platform-auth'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { scopedKey } from '@/lib/storage-scope'
import { RpcError } from '../protocol/envelope'

/**
 * Wallet sign-in (`dash-key:`) and first-login key registration (`dash-st:`),
 * the state machines of platform-auth's `useYapprKeyExchangeLogin` and
 * `useYapprKeyRegistration` (vendor/platform-auth/src/key-exchange/yappr-hooks.tsx)
 * without React. The ephemeral private key stays in the engine, keyed by
 * `requestId`.
 *
 * Mobile differences (PRD AUTH-03, AUTH-06):
 *  - A request lives 10 minutes. Each `await` call waits at most `waitMs`
 *    (the RPC has one deadline per client) and answers `pending` when the
 *    wallet has not answered yet; the host calls again ("Check again").
 *  - Until the wallet answers, the request (ephemeral key included) is also
 *    kept in the secure area, so a request survives the app being killed.
 *    Nothing derived from the wallet's answer is ever persisted.
 */

export const REQUEST_LIFETIME_MS = 10 * 60 * 1000
export const DEFAULT_WAIT_MS = 45_000
const MAX_WAIT_MS = 120_000
export const REGISTRATION_POLL_MS = 5_000
/** Secure area (Keychain/Keystore on the host): the one request still waiting for its wallet. */
export const PENDING_REQUEST_KEY = scopedKey('yappr_secure_kx_request')

export interface KeyExchangeRequestDTO {
  requestId: string
  /** `dash-key:` URI to open in the wallet or show as a QR code. */
  uri: string
  expiresAt: Date
}

export interface KeyToRegister {
  keyId: number
  purpose: 'authentication' | 'encryption'
  securityLevel: 'high' | 'medium'
}

export type KeyExchangeStep<S> =
  | { status: 'pending'; requestId: string; expiresAt: Date }
  | { status: 'signed-in'; session: S }
  | { status: 'needs-registration'; requestId: string; uri: string; expiresAt: Date; keys: KeyToRegister[] }

interface Approval {
  identityId: string
  loginKey: Uint8Array
  keyIndex: number
  authKey: Uint8Array
  encryptionKey: Uint8Array
  registration?: { uri: string; keys: KeyToRegister[] }
}

interface Request {
  requestId: string
  uri: string
  expiresAt: number
  ephemeralKey: Uint8Array
  pubKeyHash: Uint8Array
  approval?: Approval
  poll?: AbortController
}

interface StoredRequest {
  requestId: string
  uri: string
  expiresAt: number
  ephemeralKeyHex: string
}

export interface KeyExchangeOptions<S> {
  controller: PlatformAuthController
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** Sign in with the wallet's login key (the controller's `completeYapprKeyExchangeLogin` plus the engine's bookkeeping). */
  complete(identityId: string, loginKey: Uint8Array, keyIndex: number): Promise<S>
  now?(): number
  newId?(): string
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Cancelled'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function clampWait(waitMs: number | undefined): number {
  return Math.min(Math.max(waitMs ?? DEFAULT_WAIT_MS, 0), MAX_WAIT_MS)
}

export function createKeyExchange<S>(options: KeyExchangeOptions<S>) {
  const { controller, storage } = options
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())
  const sleep = options.sleep ?? abortableSleep
  const requests = new Map<string, Request>()

  function wipe(request: Request): void {
    request.poll?.abort()
    clearSensitiveBytes(request.ephemeralKey)
    if (request.approval) {
      clearSensitiveBytes(request.approval.loginKey)
      clearSensitiveBytes(request.approval.authKey)
      clearSensitiveBytes(request.approval.encryptionKey)
    }
    requests.delete(request.requestId)
    if (readStored()?.requestId === request.requestId) storage.removeItem(PENDING_REQUEST_KEY)
  }

  function readStored(): StoredRequest | null {
    try {
      const stored = JSON.parse(storage.getItem(PENDING_REQUEST_KEY) ?? 'null') as StoredRequest | null
      return stored && typeof stored.requestId === 'string' && typeof stored.ephemeralKeyHex === 'string' ? stored : null
    } catch {
      return null
    }
  }

  /** The persisted request, back in memory after an engine restart. */
  function rehydrate(): void {
    const stored = readStored()
    if (!stored || requests.has(stored.requestId)) return
    if (stored.expiresAt <= now()) {
      storage.removeItem(PENDING_REQUEST_KEY)
      return
    }
    const ephemeralKey = hexToBytes(stored.ephemeralKeyHex)
    requests.set(stored.requestId, {
      requestId: stored.requestId,
      uri: stored.uri,
      expiresAt: stored.expiresAt,
      ephemeralKey,
      pubKeyHash: hash160(getYapprPublicKey(ephemeralKey)),
    })
  }

  function live(requestId: string, expiredCode: 'KEY_EXCHANGE_TIMEOUT' | 'KEY_REGISTRATION_TIMEOUT'): Request {
    rehydrate()
    const request = requests.get(requestId)
    if (!request) throw new RpcError('This sign-in request is no longer available. Start a new one.', expiredCode)
    if (request.expiresAt <= now()) {
      wipe(request)
      throw new RpcError('This sign-in request expired. Start a new one.', expiredCode)
    }
    return request
  }

  /** Make this the request's only poll: a second caller aborts the first. */
  function beginPoll(request: Request): AbortSignal {
    request.poll?.abort()
    const poll = new AbortController()
    request.poll = poll
    return poll.signal
  }

  async function finish(request: Request): Promise<KeyExchangeStep<S>> {
    const approval = request.approval
    if (!approval) throw new RpcError('The wallet has not answered this request yet', 'BAD_REQUEST')
    const session = await options.complete(approval.identityId, approval.loginKey, approval.keyIndex)
    wipe(request)
    return { status: 'signed-in', session }
  }

  async function registration(request: Request, approval: Approval): Promise<KeyExchangeStep<S>> {
    if (!approval.registration) {
      const config = controller.getYapprKeyExchangeConfig()
      const transition = await controller.buildYapprUnsignedKeyRegistrationTransition({
        identityId: approval.identityId,
        authPrivateKey: approval.authKey,
        authPublicKey: getYapprPublicKey(approval.authKey),
        encryptionPrivateKey: approval.encryptionKey,
        encryptionPublicKey: getYapprPublicKey(approval.encryptionKey),
      })
      approval.registration = {
        uri: buildYapprStateTransitionUri(transition.transitionBytes, config.network),
        keys: [
          { keyId: transition.authKeyId, purpose: 'authentication', securityLevel: 'high' },
          { keyId: transition.encryptionKeyId, purpose: 'encryption', securityLevel: 'medium' },
        ],
      }
    }
    return {
      status: 'needs-registration',
      requestId: request.requestId,
      uri: approval.registration.uri,
      expiresAt: new Date(request.expiresAt),
      keys: approval.registration.keys,
    }
  }

  function keysRegistered(approval: Approval): Promise<boolean> {
    return controller.checkYapprKeysRegistered(
      approval.identityId,
      getYapprPublicKey(approval.authKey),
      getYapprPublicKey(approval.encryptionKey),
    )
  }

  function cancelled(error: unknown): boolean {
    return error instanceof Error && error.message === 'Cancelled'
  }

  return {
    /** A new `dash-key:` request. Any earlier request is abandoned (one sign-in at a time). */
    start(): KeyExchangeRequestDTO {
      rehydrate()
      for (const request of [...requests.values()]) wipe(request)
      const config = controller.getYapprKeyExchangeConfig()
      const ephemeral = generateYapprEphemeralKeyPair()
      const uri = buildYapprKeyExchangeUri({
        appEphemeralPubKey: ephemeral.publicKey,
        contractId: decodeYapprContractId(config.appContractId),
        label: config.label,
      }, config.network)
      const request: Request = {
        requestId: newId(),
        uri,
        expiresAt: now() + REQUEST_LIFETIME_MS,
        ephemeralKey: ephemeral.privateKey,
        pubKeyHash: hash160(ephemeral.publicKey),
      }
      requests.set(request.requestId, request)
      const stored: StoredRequest = {
        requestId: request.requestId,
        uri,
        expiresAt: request.expiresAt,
        ephemeralKeyHex: bytesToHex(ephemeral.privateKey),
      }
      storage.setItem(PENDING_REQUEST_KEY, JSON.stringify(stored))
      return { requestId: request.requestId, uri, expiresAt: new Date(request.expiresAt) }
    },

    /** The request still waiting for its wallet, if any (after an app restart: resume it). */
    pending(): KeyExchangeRequestDTO | null {
      rehydrate()
      const request = [...requests.values()].find(r => !r.approval && r.expiresAt > now())
      return request ? { requestId: request.requestId, uri: request.uri, expiresAt: new Date(request.expiresAt) } : null
    },

    /**
     * Wait up to `waitMs` for the wallet's answer. Then: signed in when the
     * identity already has Yappr's keys; otherwise the `dash-st:` key
     * registration to open in the wallet. `pending` when the wallet has not
     * answered yet.
     */
    async await(requestId: string, waitMs?: number): Promise<KeyExchangeStep<S>> {
      const request = live(requestId, 'KEY_EXCHANGE_TIMEOUT')
      if (!request.approval) {
        const signal = beginPoll(request)
        const wait = clampWait(waitMs)
        let decrypted
        try {
          decrypted = await controller.pollYapprKeyExchangeResponse(
            request.pubKeyHash,
            request.ephemeralKey,
            // A short wait still polls once, and never sleeps past its deadline.
            { timeoutMs: Math.max(wait, 1), pollIntervalMs: Math.min(DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.pollIntervalMs, Math.max(wait, 1)) },
            { signal },
          )
        } catch (error) {
          if (cancelled(error)) throw new RpcError('Sign-in was cancelled', 'KEY_EXCHANGE_CANCELLED')
          if (error instanceof Error && error.message.startsWith('Timeout')) {
            return { status: 'pending', requestId, expiresAt: new Date(request.expiresAt) }
          }
          throw error
        }
        if (!requests.has(requestId)) {
          clearSensitiveBytes(decrypted.loginKey)
          throw new RpcError('Sign-in was cancelled', 'KEY_EXCHANGE_CANCELLED')
        }
        const identityIdBytes = decodeYapprIdentityId(decrypted.identityId)
        request.approval = {
          identityId: decrypted.identityId,
          loginKey: decrypted.loginKey,
          keyIndex: decrypted.keyIndex,
          authKey: deriveYapprAuthKeyFromLogin(decrypted.loginKey, identityIdBytes),
          encryptionKey: deriveYapprEncryptionKeyFromLogin(decrypted.loginKey, identityIdBytes),
        }
        // Answered: the ephemeral key has done its job, and nothing past this point is persisted.
        clearSensitiveBytes(request.ephemeralKey)
        storage.removeItem(PENDING_REQUEST_KEY)
        // Registration can take minutes: the window restarts from the approval.
        request.expiresAt = now() + REQUEST_LIFETIME_MS
      }
      const approval = request.approval
      return (await keysRegistered(approval)) ? finish(request) : registration(request, approval)
    },

    /**
     * After the wallet signed and broadcast the registration: check every 5 s,
     * for up to `waitMs`, until the keys are on the identity, then sign in.
     * `pending` while they are not there yet (the host keeps calling: PRD AUTH-06).
     */
    async awaitRegistration(requestId: string, waitMs?: number): Promise<KeyExchangeStep<S>> {
      const request = live(requestId, 'KEY_REGISTRATION_TIMEOUT')
      const approval = request.approval
      if (!approval) throw new RpcError('The wallet has not answered this request yet', 'BAD_REQUEST')
      const signal = beginPoll(request)
      const deadline = now() + clampWait(waitMs)
      for (;;) {
        try {
          if (await keysRegistered(approval)) break
        } catch {
          // Transient read failures keep polling, as the web hook does.
        }
        if (now() + REGISTRATION_POLL_MS > deadline) {
          return { status: 'pending', requestId, expiresAt: new Date(request.expiresAt) }
        }
        try {
          await sleep(REGISTRATION_POLL_MS, signal)
        } catch {
          throw new RpcError('Sign-in was cancelled', 'KEY_EXCHANGE_CANCELLED')
        }
      }
      if (signal.aborted || !requests.has(requestId)) throw new RpcError('Sign-in was cancelled', 'KEY_EXCHANGE_CANCELLED')
      return finish(request)
    },

    /** Abandon a request: stop its poll and zero its keys. */
    cancel(requestId: string): void {
      rehydrate()
      const request = requests.get(requestId)
      if (request) wipe(request)
    },
  }
}

export type KeyExchange<S> = ReturnType<typeof createKeyExchange<S>>
