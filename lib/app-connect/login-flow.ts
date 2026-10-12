import * as secp256k1 from '@noble/secp256k1'
import {
  APP_CONNECT_MAX_REQUEST_AGE_MS,
  appConnectCandidateKey,
  appConnectPollDelayMs,
  appConnectRequestHash,
  buildAppConnectUri,
  clearSensitiveBytes,
  getYapprPublicKey,
  listAppConnectCandidates,
  verifyAppConnectCandidate,
  type AppConnectCandidate,
  type AppConnectGrant,
  type AppConnectRequest,
  type AppConnectVerification,
  type VerifyAppConnectCandidateInput,
  type YapprKeyExchangeNetworkName,
} from 'platform-auth'
import { bytesToHex, hexToBytes } from '@/lib/bytes'
import { APP_CONNECT_MIN_PROTOCOL_VERSION, type AppConnectPins } from './config'
import type { AppConnectTrust } from './group-trust'
import type { AppConnectPlatformPort } from './platform-port'
import { appConnectCallbackUrl, buildYapprAppConnectRequest } from './yappr-request'

/**
 * The App Connect sign-in, from the QR code to a verified grant
 * (docs/APP_CONNECT_PROFILE.md, "App rules"):
 *
 *   checking → waiting (QR) → confirm (one or more verified identities)
 *
 * with `timeout` after 10 minutes ("Check again" re-polls the same request
 * while it is still fresh, else starts a new one), `too-many` when spam buries
 * the request, and `unavailable` when the network or the group cannot be
 * trusted. Nothing here signs anyone in: `confirm` hands verified grants to the
 * UI, which asks "Continue as @name?" and then calls `loginWithAppConnect`.
 */

/** `storage`: the browser would not keep this device's connection id (IndexedDB blocked). */
export type AppConnectUnavailableReason = 'not-configured' | 'network-not-ready' | 'untrusted' | 'offline' | 'storage'

export interface VerifiedCandidate {
  identityId: string
  grant: AppConnectGrant
}

export type AppConnectLoginState =
  | { phase: 'checking' }
  | { phase: 'unavailable'; reason: AppConnectUnavailableReason }
  | { phase: 'waiting'; uri: string }
  | { phase: 'confirm'; uri: string; candidates: VerifiedCandidate[] }
  | { phase: 'timeout'; uri: string }
  | { phase: 'too-many' }

/** The request a tab is waiting on, kept so a reload or the /connect page can pick it up. */
export interface StoredAppConnectRequest {
  ephemeralPrivateKey: string
  createdAt: number
  connectionId: string
  identityHint?: string
}

/**
 * Where the pending request lives between polls (and across a reload or the
 * wallet's return page). The ephemeral private key it holds opens the wallet's
 * answer, which carries the granted keys, so a real store wraps it rather than
 * leaving it in plain storage. Async so that store can be IndexedDB.
 */
/** Writes (save, clear) must take effect in the order they are called. */
export interface RequestRecordStore {
  load(): Promise<StoredAppConnectRequest | null>
  save(record: StoredAppConnectRequest): Promise<void>
  /** Forgets the stored request, but only if it is still `record` (another tab may have replaced it). */
  clear(record: StoredAppConnectRequest): Promise<void>
}

export interface AppConnectLoginDeps {
  pins: AppConnectPins
  network: YapprKeyExchangeNetworkName
  port: AppConnectPlatformPort
  trust: () => Promise<AppConnectTrust>
  connectionId: () => Promise<string>
  records: RequestRecordStore
  /** Origin and base path for the wallet's return link. */
  origin: string
  basePath: string
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  verify?: (input: VerifyAppConnectCandidateInput) => Promise<AppConnectVerification>
  onError?: (message: string, error: unknown) => void
}

/** How long a lagging identity read may keep a candidate in "not visible yet". */
const RETRY_WINDOW_MS = 15_000
const MAX_VERIFY_ATTEMPTS = 3

export function parseStoredRequest(raw: unknown, now: number): StoredAppConnectRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const { ephemeralPrivateKey, createdAt, connectionId, identityHint } = record
  if (typeof ephemeralPrivateKey !== 'string' || !/^[0-9a-f]{64}$/.test(ephemeralPrivateKey)) return null
  if (typeof connectionId !== 'string' || !/^[0-9a-f]{32}$/.test(connectionId)) return null
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)) return null
  if (now - createdAt >= APP_CONNECT_MAX_REQUEST_AGE_MS || createdAt - now > 60_000) return null
  if (identityHint !== undefined && typeof identityHint !== 'string') return null
  return { ephemeralPrivateKey, createdAt, connectionId, ...(identityHint ? { identityHint } : {}) }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

interface ActiveRequest {
  record: StoredAppConnectRequest
  privateKey: Uint8Array
  request: AppConnectRequest
  hash: Uint8Array
  uri: string
}

interface CandidateProgress {
  firstSeen: number
  attempts: number
  done: boolean
}

export class AppConnectLogin {
  private state: AppConnectLoginState = { phase: 'checking' }
  private readonly listeners = new Set<(state: AppConnectLoginState) => void>()
  private active: ActiveRequest | null = null
  private abort: AbortController | null = null
  private wake: (() => void) | null = null
  private progress = new Map<string, CandidateProgress>()
  private verified: VerifiedCandidate[] = []
  /** Bumped by every start and by dispose, so an older start that is still awaiting stops where it is. */
  private generation = 0
  private disposed = false
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly verify: (input: VerifyAppConnectCandidateInput) => Promise<AppConnectVerification>

  constructor(private readonly deps: AppConnectLoginDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.verify = deps.verify ?? verifyAppConnectCandidate
  }

  getState(): AppConnectLoginState {
    return this.state
  }

  subscribe(listener: (state: AppConnectLoginState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  private set(state: AppConnectLoginState): void {
    this.state = state
    this.listeners.forEach((listener) => listener(state))
  }

  /**
   * Checks the network and the group, then resumes a stored request (a
   * reload, or the wallet's return link) or starts a new one. `identityHint`
   * (renewal) accepts only that identity.
   */
  async start(options: { identityHint?: string; fresh?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    const current = () => !this.disposed && this.generation === generation
    this.stop()
    this.set({ phase: 'checking' })
    try {
      const status = await this.deps.port.chainStatus()
      if (!current()) return
      if (status.protocolVersion < APP_CONNECT_MIN_PROTOCOL_VERSION) {
        this.set({ phase: 'unavailable', reason: 'network-not-ready' })
        return
      }
      const trust = await this.deps.trust()
      if (!current()) return
      if (!trust.ok) {
        this.set({ phase: 'unavailable', reason: 'untrusted' })
        return
      }
    } catch (error) {
      if (!current()) return
      this.deps.onError?.('App Connect: the network check failed', error)
      this.set({ phase: 'unavailable', reason: 'offline' })
      return
    }

    let record: StoredAppConnectRequest | null
    try {
      const stored = options.fresh ? null : await this.deps.records.load()
      if (!current()) return
      const resumable = stored && stored.identityHint === options.identityHint ? stored : null
      record = resumable ?? await this.newRecord(options.identityHint, current)
    } catch (error) {
      if (!current()) return
      this.deps.onError?.('App Connect: could not prepare the request', error)
      this.set({ phase: 'unavailable', reason: 'storage' })
      return
    }
    if (!record || !current()) return
    this.activate(record)
    this.poll()
  }

  /**
   * A new request, stored for resuming. `current` is checked right before
   * the save is issued: a start that a newer one superseded stores nothing,
   * so it cannot overwrite the newer request (the store applies writes in
   * the order they are issued).
   */
  private async newRecord(identityHint: string | undefined, current: () => boolean): Promise<StoredAppConnectRequest | null> {
    const privateKey = secp256k1.utils.randomSecretKey()
    const record: StoredAppConnectRequest = {
      ephemeralPrivateKey: bytesToHex(privateKey),
      createdAt: this.now(),
      connectionId: await this.deps.connectionId(),
      ...(identityHint ? { identityHint } : {}),
    }
    clearSensitiveBytes(privateKey)
    if (!current()) return null
    await this.deps.records.save(record)
    // Overtaken while saving (a finish, a newer start or an unmount): forget
    // this request again; the clear only removes it if it is still the stored one.
    if (!current()) {
      this.clearRecord(record)
      return null
    }
    return record
  }

  private activate(record: StoredAppConnectRequest): void {
    // A new request replaces the old one: its ephemeral key is no longer needed.
    if (this.active) clearSensitiveBytes(this.active.privateKey)
    const privateKey = hexToBytes(record.ephemeralPrivateKey)
    const request = buildYapprAppConnectRequest({
      pins: this.deps.pins,
      appEphemeralPubKey: getYapprPublicKey(privateKey),
      connectionId: hexToBytes(record.connectionId),
      createdAt: record.createdAt,
      identityHint: record.identityHint,
    })
    const hash = appConnectRequestHash(request)
    const callbackUrl = appConnectCallbackUrl(this.deps.origin, this.deps.basePath, bytesToHex(hash))
    this.active = { record, privateKey, request, hash, uri: buildAppConnectUri(request, this.deps.network, callbackUrl) }
    this.progress = new Map()
    this.discardVerified()
    this.set({ phase: 'waiting', uri: this.active.uri })
  }

  /** The request hash the QR code carries (hex), for matching the wallet's return link. */
  requestHashHex(): string | null {
    return this.active ? bytesToHex(this.active.hash) : null
  }

  /** Poll right now (window focus, the wallet's return link). */
  pollNow(): void {
    this.wake?.()
  }

  /** After a timeout: poll the same request again while the wallet still accepts it, else start fresh. */
  async checkAgain(): Promise<void> {
    const active = this.active
    if (active && this.now() - active.record.createdAt < APP_CONNECT_MAX_REQUEST_AGE_MS) {
      this.set({ phase: 'waiting', uri: active.uri })
      this.poll()
      return
    }
    await this.start({ identityHint: active?.record.identityHint, fresh: true })
  }

  /**
   * The user picked `identityId`: hands back its grant and forgets the
   * request and every other candidate. The caller signs in with the grant
   * (which wipes its keys).
   */
  accept(identityId: string): AppConnectGrant | null {
    const chosen = this.verified.find((candidate) => candidate.identityId === identityId) ?? null
    this.verified = this.verified.filter((candidate) => candidate !== chosen)
    this.finish()
    return chosen?.grant ?? null
  }

  /** "That's not me": drop everything, including the request someone else answered, and show a new code. */
  async reject(): Promise<void> {
    const hint = this.active?.record.identityHint
    this.finish()
    await this.start({ identityHint: hint, fresh: true })
  }

  /**
   * Stops polling and wipes the request (here and in the record store) and any
   * verified keys. A start still preparing its request is overtaken too: it
   * activates nothing, and the clear follows any save it already issued.
   */
  finish(): void {
    this.generation += 1
    const record = this.active?.record
    this.teardown()
    if (record) this.clearRecord(record)
  }

  /**
   * Unmount: stops everything, including a start still awaiting its checks,
   * and wipes the keys held here. The stored request stays while the wallet
   * may still answer it, so a reload or the wallet's return page can resume
   * it; a request that has run out is cleared.
   */
  dispose(): void {
    const active = this.active
    this.disposed = true
    this.generation += 1
    this.teardown()
    this.listeners.clear()
    // Before a request is active there is nothing of ours to forget; a stale
    // stored one is dropped the next time it is loaded.
    if (active && this.now() - active.record.createdAt >= APP_CONNECT_MAX_REQUEST_AGE_MS) this.clearRecord(active.record)
  }

  private teardown(): void {
    this.stop()
    this.discardVerified()
    if (this.active) clearSensitiveBytes(this.active.privateKey)
    this.active = null
  }

  private clearRecord(record: StoredAppConnectRequest): void {
    this.deps.records.clear(record).catch((error: unknown) => this.deps.onError?.('App Connect: could not clear the request', error))
  }

  private stop(): void {
    this.abort?.abort()
    this.abort = null
    this.wake = null
  }

  private discardVerified(): void {
    for (const candidate of this.verified) this.wipeGrant(candidate.grant)
    this.verified = []
  }

  private poll(): void {
    this.stop()
    const controller = new AbortController()
    this.abort = controller
    this.pollLoop(controller.signal).catch((error: unknown) => {
      this.deps.onError?.('App Connect: the poll loop stopped', error)
    })
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    const active = this.active
    if (!active) return
    for (;;) {
      if (signal.aborted) return
      try {
        const done = await this.pollOnce(active, signal)
        if (done || signal.aborted) return
      } catch (error) {
        // A failed read is retried on the next tick; it says nothing about the request.
        this.deps.onError?.('App Connect: polling failed', error)
      }
      const delay = appConnectPollDelayMs(this.now() - active.record.createdAt)
      if (delay === null) {
        // Answers already verified stay on offer; only an unanswered request times out.
        if (!signal.aborted && this.verified.length === 0) this.set({ phase: 'timeout', uri: active.uri })
        return
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
        this.sleep(delay, signal).then(resolve, resolve)
      })
      this.wake = null
    }
  }

  /** One round: list, verify what is new or still retrying. True when the flow moved on. */
  private async pollOnce(active: ActiveRequest, signal: AbortSignal): Promise<boolean> {
    const { candidates, truncated } = await listAppConnectCandidates(this.deps.port, active.hash, {
      hint: active.record.identityHint,
    })
    if (signal.aborted) return true
    if (truncated) {
      this.set({ phase: 'too-many' })
      this.finish()
      return true
    }
    const pending = candidates.filter((candidate) => this.needsVerification(candidate))
    if (pending.length === 0) return false

    let now = this.now()
    try {
      now = (await this.deps.port.chainStatus()).blockTimeMs || now
    } catch {
      // The wall clock stands in for the block time.
    }
    let verifiedNow = false
    for (const candidate of pending) {
      if (signal.aborted) return true
      const key = appConnectCandidateKey(candidate)
      const progress = this.progress.get(key) as CandidateProgress
      progress.attempts += 1
      const result = await this.verify({
        request: active.request,
        appEphemeralPrivateKey: active.privateKey,
        candidate,
        identity: this.deps.port,
        now,
      })
      if (signal.aborted) {
        if (result.ok) this.wipeGrant(result.grant)
        return true
      }
      if (result.ok) {
        progress.done = true
        verifiedNow = true
        // An identity that republished replaces its earlier answer; wipe that one's keys.
        for (const replaced of this.verified.filter((v) => v.identityId === result.grant.identityId)) this.wipeGrant(replaced.grant)
        this.verified = [...this.verified.filter((v) => v.identityId !== result.grant.identityId), { identityId: result.grant.identityId, grant: result.grant }]
      } else if (!result.retryable || progress.attempts >= MAX_VERIFY_ATTEMPTS || this.now() - progress.firstSeen > RETRY_WINDOW_MS) {
        progress.done = true
      }
    }
    if (verifiedNow) {
      // Polling continues while the user decides: anyone else who answers
      // this code is added, and the confirm card becomes a chooser.
      this.set({ phase: 'confirm', uri: active.uri, candidates: [...this.verified] })
    }
    return false
  }

  private needsVerification(candidate: AppConnectCandidate): boolean {
    const key = appConnectCandidateKey(candidate)
    const progress = this.progress.get(key)
    if (!progress) {
      this.progress.set(key, { firstSeen: this.now(), attempts: 0, done: false })
      return true
    }
    return !progress.done
  }

  private wipeGrant(grant: AppConnectGrant): void {
    for (const key of [...grant.authKeys, ...grant.encryptionKeys]) clearSensitiveBytes(key.privateKey)
  }
}
