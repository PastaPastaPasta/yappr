/**
 * Step-up signing: the account's CRITICAL authentication key, asked for only
 * when an action that needs it is confirmed. Moderation transitions (Platform
 * signs them like a contract update, CRITICAL only) and token transitions (the
 * starter claim, YAPP tips and purchases) take it; a session that signs with
 * something less (a wallet's key ring, a HIGH key, a passkey's HIGH key) is
 * asked for it on the spot instead of being sent to sign in again.
 *
 * A key given here lives in this module's memory only: never in localStorage,
 * sessionStorage or IndexedDB, never logged, and gone when the tab closes or
 * reloads. "Keep for this tab" holds it for the session it was given in: any
 * sign-in or sign-out ends it (`bindCriticalKeySession`), and sign-outs and
 * account switches also clear it at once (`forgetCriticalKeysOnIdentityChange`,
 * `forgetCriticalKey` from `clearTabSecrets`). Otherwise it signs the one
 * action and is dropped. A
 * recovery-phrase sign-in holds the CRITICAL key its phrase derives the same
 * way, so its session is never asked.
 *
 * Every key is matched against the identity's enabled CRITICAL authentication
 * key before it signs: one for another identity never matches.
 */
import { matchIdentityKey, type IdentityKeyLike } from '@/lib/crypto/keys'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { keyNetwork } from '@/lib/constants'
import { currentIdentityId } from '@/lib/auth/active-identity'

/** What the key is about to sign. */
export type CriticalKeyUse = 'moderation' | 'token'

/**
 * Where a key came from. A passkey's CRITICAL key moderates but never signs a
 * token transition (owner decision V2, docs/PASSKEY_VAULT.md).
 */
export type CriticalKeySource = 'typed' | 'phrase' | 'passkey'

export interface CriticalKeyRequest {
  /** Tells one request from the next, so the sheet starts afresh for each. */
  id: number
  identityId: string
  use: CriticalKeyUse
}

export interface CriticalKeyAnswer {
  wif: string
  source: CriticalKeySource
  /** Hold it for the rest of this tab's session (until sign-out or a switch of account). */
  keep: boolean
}

/** The user closed the sheet: the action stops before anything is signed. */
export class CriticalKeyCancelledError extends Error {
  constructor() {
    super('The highest-security key was not given')
    this.name = 'CriticalKeyCancelledError'
  }
}

/** The marker the services turn into NEEDS_CRITICAL_KEY (no sheet to ask with, or a key that does not fit). */
export const CRITICAL_KEY_REQUIRED = 'critical key required'

function usableFor(source: CriticalKeySource, use: CriticalKeyUse): boolean {
  return use === 'moderation' || source !== 'passkey'
}

/** Each held key with the session it was given in: another session (any sign-in or sign-out since) never uses it. */
const held = new Map<string, { wif: string; source: CriticalKeySource; session: number }>()

let sessionEpoch: () => number = () => 0

/** Binds the auth controller's session epoch, which every sign-in and sign-out moves on. Returns the unbind. */
export function bindCriticalKeySession(read: () => number): () => void {
  sessionEpoch = read
  return () => { if (sessionEpoch === read) sessionEpoch = () => 0 }
}

/** Holds `identityId`'s CRITICAL key in memory for this session in this tab. The caller has matched it to the identity. */
export function holdCriticalKey(identityId: string, wif: string, source: CriticalKeySource): void {
  held.set(identityId, { wif, source, session: sessionEpoch() })
}

export function forgetCriticalKey(identityId: string): void {
  held.delete(identityId)
  if (pending?.request.identityId === identityId) settle(null)
}

/** Keeps only `identityId`'s key (none when signed out), and drops a sheet open for anyone else. */
function keepOnly(identityId: string | null): void {
  for (const id of [...held.keys()]) if (id !== identityId) held.delete(id)
  if (pending && pending.request.identityId !== identityId) settle(null)
}

interface IdentityState {
  user: { identityId: string } | null
}

/**
 * Forgets every other identity's CRITICAL key, and closes a sheet open for
 * one, whenever the signed-in identity changes: a sign-out by any route or a
 * switch of account. The identity just signed in keeps what its own sign-in
 * stored (a recovery phrase's CRITICAL key). Returns the unsubscribe.
 */
export function forgetCriticalKeysOnIdentityChange(
  current: IdentityState,
  subscribe: (listener: (state: IdentityState) => void) => () => void,
): () => void {
  let identityId = current.user?.identityId ?? null
  return subscribe((state) => {
    const next = state.user?.identityId ?? null
    if (next === identityId) return
    identityId = next
    keepOnly(next)
  })
}

// The sheet. One request at a time; the mounted sheet is the only listener.

interface Pending {
  request: CriticalKeyRequest
  promise: Promise<CriticalKeyAnswer | null>
  resolve: (answer: CriticalKeyAnswer | null) => void
}

let pending: Pending | null = null
const listeners = new Set<() => void>()

/** Settles the open request (only `request`, when given: a late answer never settles a request opened since). */
function settle(answer: CriticalKeyAnswer | null, request?: CriticalKeyRequest): void {
  const settled = pending
  if (!settled || (request && settled.request !== request)) return
  pending = null
  settled.resolve(answer)
  listeners.forEach((listener) => listener())
}

/** For the sheet (useSyncExternalStore): subscribing also marks it mounted, so requests can be asked. */
export function subscribeCriticalKeyRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    // The last sheet went away with a request open: nobody can answer it.
    if (listeners.size === 0) settle(null)
  }
}

export function currentCriticalKeyRequest(): CriticalKeyRequest | null {
  return pending?.request ?? null
}

/** The sheet's answer to `request` (the one it showed); ignored once that request is no longer open. */
export function answerCriticalKeyRequest(request: CriticalKeyRequest, answer: CriticalKeyAnswer): void {
  settle(answer, request)
}

export function cancelCriticalKeyRequest(request: CriticalKeyRequest): void {
  settle(null, request)
}

let requests = 0

function ask(identityId: string, use: CriticalKeyUse): Promise<CriticalKeyAnswer | null> {
  if (pending && pending.request.identityId === identityId && pending.request.use === use) return pending.promise
  settle(null)
  let resolve!: (answer: CriticalKeyAnswer | null) => void
  const promise = new Promise<CriticalKeyAnswer | null>((done) => { resolve = done })
  pending = { request: { id: ++requests, identityId, use }, promise, resolve }
  listeners.forEach((listener) => listener())
  return promise
}

function matchCritical<K extends IdentityKeyLike>(wif: string, publicKeys: readonly K[]) {
  return matchIdentityKey(wif, publicKeys, {
    network: keyNetwork(),
    purpose: KeyPurpose.AUTHENTICATION,
    allowedSecurityLevels: [SecurityLevel.CRITICAL],
  })
}

/** The session a write starts in: read it before the session key, and pass both to {@link criticalKeyFor}. */
export function criticalKeySession(): number {
  return sessionEpoch()
}

/** Steps 1 and 2 of {@link criticalKeyFor}, without asking: the key that would sign now, or null. */
export function availableCriticalKey<K extends IdentityKeyLike>(
  identityId: string,
  publicKeys: readonly K[],
  use: CriticalKeyUse,
  sessionKey: string | null,
): { wif: string; key: K } | null {
  if (sessionKey) {
    const result = matchCritical(sessionKey, publicKeys)
    if (result.ok) return { wif: sessionKey, key: result.key }
  }
  const kept = held.get(identityId)
  if (!kept) return null
  // Given in an earlier session (say, before a wallet sign-in as the same identity): never used again.
  if (kept.session !== sessionEpoch()) {
    held.delete(identityId)
    return null
  }
  if (!usableFor(kept.source, use)) return null
  const result = matchCritical(kept.wif, publicKeys)
  if (result.ok) return { wif: kept.wif, key: result.key }
  // Disabled or replaced since it was given: never offered again.
  held.delete(identityId)
  return null
}

/**
 * The CRITICAL key that signs `use` for `identityId`, with the identity key
 * it matches in `publicKeys` (the identity's keys, read for this write):
 *
 * 1. `sessionKey`, the key the session signs with (the caller leaves out a
 *    wallet session's and, for tokens, a passkey's), when it is CRITICAL;
 * 2. the key this tab holds, when it may sign `use` and still matches (one
 *    disabled since is dropped);
 * 3. otherwise the sheet asks.
 *
 * `session` is {@link criticalKeySession} as the caller read `sessionKey`:
 * only that session, still signed in as `identityId`, gets a key on any path,
 * so a sign-out or a switch of account while the identity was read, or while
 * the sheet was open, stops the action (CriticalKeyCancelledError).
 *
 * Throws {@link CriticalKeyCancelledError} when the sheet is closed, and the
 * {@link CRITICAL_KEY_REQUIRED} marker where no sheet is mounted (the mobile
 * engine) or the answer does not match.
 */
export async function criticalKeyFor<K extends IdentityKeyLike>(
  identityId: string,
  publicKeys: readonly K[],
  use: CriticalKeyUse,
  sessionKey: string | null,
  session: number,
): Promise<{ wif: string; key: K; assertLive: () => void }> {
  const stillSignedIn = () => currentIdentityId() === identityId && sessionEpoch() === session
  // For the caller to run once more right before the write goes out (after the signer is built and the
  // write lock is held), so a sign-out meanwhile still stops it.
  const assertLive = () => { if (!stillSignedIn()) throw new CriticalKeyCancelledError() }
  assertLive()
  const available = availableCriticalKey(identityId, publicKeys, use, sessionKey)
  if (available) return { ...available, assertLive }
  if (listeners.size === 0) throw new Error(CRITICAL_KEY_REQUIRED)
  const answer = await ask(identityId, use)
  if (!answer || !stillSignedIn()) throw new CriticalKeyCancelledError()
  const result = usableFor(answer.source, use) ? matchCritical(answer.wif, publicKeys) : null
  if (!result?.ok) throw new Error(CRITICAL_KEY_REQUIRED)
  if (answer.keep) holdCriticalKey(identityId, answer.wif, answer.source)
  return { wif: answer.wif, key: result.key, assertLive }
}
