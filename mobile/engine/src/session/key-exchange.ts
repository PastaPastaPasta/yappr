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
import { readJson } from '../read-json'
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

const REQUEST_LIFETIME_MS = 10 * 60 * 1000
const DEFAULT_WAIT_MS = 45_000
const MAX_WAIT_MS = 120_000
const REGISTRATION_POLL_MS = 5_000
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

/** platform-auth's poll and the sleep above reject with this message when aborted. */
function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.message === 'Cancelled'
}

const cancelledError = () => new RpcError('Sign-in was cancelled', 'KEY_EXCHANGE_CANCELLED')

const toRequestDTO = (request: Request): KeyExchangeRequestDTO =>
  ({ requestId: request.requestId, uri: request.uri, expiresAt: new Date(request.expiresAt) })

const pendingStep = (request: Request): KeyExchangeStep<never> =>
  ({ status: 'pending', requestId: request.requestId, expiresAt: new Date(request.expiresAt) })

export function createKeyExchange<S>(options: KeyExchangeOptions<S>) {
  const { controller, storage } = options
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())
  /** One sign-in at a time: `start` abandons any earlier request. */
  let active: Request | null = null

  function readStored(): StoredRequest | null {
    const stored = readJson<StoredRequest | null>(storage, PENDING_REQUEST_KEY, null)
    return stored && typeof stored.requestId === 'string' && typeof stored.ephemeralKeyHex === 'string' ? stored : null
  }

  function wipe(request: Request): void {
    request.poll?.abort()
    for (const key of [request.ephemeralKey, request.approval?.loginKey, request.approval?.authKey, request.approval?.encryptionKey]) {
      if (key) clearSensitiveBytes(key)
    }
    if (active === request) active = null
    if (readStored()?.requestId === request.requestId) storage.removeItem(PENDING_REQUEST_KEY)
  }

  /** The active request; after an engine restart, the persisted one back in memory. */
  function current(): Request | null {
    if (active) return active
    const stored = readStored()
    if (!stored) return null
    if (stored.expiresAt <= now()) {
      storage.removeItem(PENDING_REQUEST_KEY)
      return null
    }
    const ephemeralKey = hexToBytes(stored.ephemeralKeyHex)
    active = {
      requestId: stored.requestId,
      uri: stored.uri,
      expiresAt: stored.expiresAt,
      ephemeralKey,
      pubKeyHash: hash160(getYapprPublicKey(ephemeralKey)),
    }
    return active
  }

  function live(requestId: string, expiredCode: 'KEY_EXCHANGE_TIMEOUT' | 'KEY_REGISTRATION_TIMEOUT'): Request {
    const request = current()
    if (request?.requestId !== requestId) throw new RpcError('This sign-in request is no longer available. Start a new one.', expiredCode)
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

  async function finish(request: Request, approval: Approval): Promise<KeyExchangeStep<S>> {
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
    return { status: 'needs-registration', ...toRequestDTO(request), uri: approval.registration.uri, keys: approval.registration.keys }
  }

  function keysRegistered(approval: Approval): Promise<boolean> {
    return controller.checkYapprKeysRegistered(
      approval.identityId,
      getYapprPublicKey(approval.authKey),
      getYapprPublicKey(approval.encryptionKey),
    )
  }

  return {
    /** A new `dash-key:` request. Any earlier request is abandoned (one sign-in at a time). */
    start(): KeyExchangeRequestDTO {
      const previous = current()
      if (previous) wipe(previous)
      const config = controller.getYapprKeyExchangeConfig()
      const ephemeral = generateYapprEphemeralKeyPair()
      const request: Request = {
        requestId: newId(),
        uri: buildYapprKeyExchangeUri({
          appEphemeralPubKey: ephemeral.publicKey,
          contractId: decodeYapprContractId(config.appContractId),
          label: config.label,
        }, config.network),
        expiresAt: now() + REQUEST_LIFETIME_MS,
        ephemeralKey: ephemeral.privateKey,
        pubKeyHash: hash160(ephemeral.publicKey),
      }
      active = request
      const stored: StoredRequest = {
        requestId: request.requestId,
        uri: request.uri,
        expiresAt: request.expiresAt,
        ephemeralKeyHex: bytesToHex(ephemeral.privateKey),
      }
      storage.setItem(PENDING_REQUEST_KEY, JSON.stringify(stored))
      return toRequestDTO(request)
    },

    /** The request still waiting for its wallet, if any (after an app restart: resume it). */
    pending(): KeyExchangeRequestDTO | null {
      const request = current()
      return request && !request.approval && request.expiresAt > now() ? toRequestDTO(request) : null
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
        // A short wait still polls once, and never sleeps past its deadline.
        const budget = Math.max(clampWait(waitMs), 1)
        let decrypted
        try {
          decrypted = await controller.pollYapprKeyExchangeResponse(
            request.pubKeyHash,
            request.ephemeralKey,
            { timeoutMs: budget, pollIntervalMs: Math.min(DEFAULT_YAPPR_KEY_EXCHANGE_CONFIG.pollIntervalMs, budget) },
            { signal },
          )
        } catch (error) {
          if (isCancellation(error)) throw cancelledError()
          if (error instanceof Error && error.message.startsWith('Timeout')) return pendingStep(request)
          throw error
        }
        if (active !== request) {
          clearSensitiveBytes(decrypted.loginKey)
          throw cancelledError()
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
      return (await keysRegistered(approval)) ? finish(request, approval) : registration(request, approval)
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
        if (now() + REGISTRATION_POLL_MS > deadline) return pendingStep(request)
        try {
          await abortableSleep(REGISTRATION_POLL_MS, signal)
        } catch {
          throw cancelledError()
        }
      }
      if (signal.aborted || active !== request) throw cancelledError()
      return finish(request, approval)
    },

    /** Abandon a request: stop its poll and zero its keys. */
    cancel(requestId: string): void {
      const request = current()
      if (request?.requestId === requestId) wipe(request)
    },
  }
}
