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
 *
 * The same sheet also asks for another key an action needs ({@link askForKey}:
 * the MASTER key a moderation team's charter key is made from), checked by the
 * caller, never kept, and bound to the session the same way.
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

/**
 * Another key the sheet asks for ({@link askForKey}): its own words, and the
 * caller's check of what was typed (an error to show, or null when it fits;
 * it must not throw). What is typed is handed back once, never kept here.
 */
export interface KeyPrompt {
  title: string
  why: string
  label: string
  check: (typed: string) => Promise<string | null>
}

export interface CriticalKeyRequest {
  /** Tells one request from the next, so the sheet starts afresh for each. */
  id: number
  identityId: string
  use: CriticalKeyUse
  /** Set when the sheet asks for another key than the CRITICAL one. */
  prompt?: KeyPrompt
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

/** No sheet is mounted to ask for another key with ({@link askForKey}). */
export const KEY_SHEET_MISSING = 'no key sheet to ask with'

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

function ask(identityId: string, use: CriticalKeyUse, prompt?: KeyPrompt): Promise<CriticalKeyAnswer | null> {
  if (!prompt && pending && !pending.request.prompt && pending.request.identityId === identityId && pending.request.use === use) return pending.promise
  settle(null)
  let resolve!: (answer: CriticalKeyAnswer | null) => void
  const promise = new Promise<CriticalKeyAnswer | null>((done) => { resolve = done })
  pending = { request: { id: ++requests, identityId, use, ...(prompt ? { prompt } : {}) }, promise, resolve }
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

/**
 * A check that throws CriticalKeyCancelledError once `session` (from
 * {@link criticalKeySession}) is over or `identityId` is no longer the one
 * signed in. Run it right before a write goes out (after the signer is built
 * and the write lock is held), so a sign-out meanwhile still stops it.
 */
export function liveSessionCheck(identityId: string, session: number): () => void {
  return () => {
    if (currentIdentityId() !== identityId || sessionEpoch() !== session) throw new CriticalKeyCancelledError()
  }
}

/** Steps 1 and 2 of {@link criticalKeyFor}, without asking: the key that would sign now, or null. */
export function availableCriticalKey<K extends IdentityKeyLike>(
  identityId: string,
  publicKeys: readonly K[],
  use: CriticalKeyUse,
  sessionKey: string | null,
  accept: (key: K) => boolean = () => true,
): { wif: string; key: K } | null {
  if (sessionKey) {
    const result = matchCritical(sessionKey, publicKeys)
    if (result.ok && accept(result.key)) return { wif: sessionKey, key: result.key }
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
  // One the caller can't sign with (say, bound to another contract) is kept for others; this one asks.
  if (result.ok) return accept(result.key) ? { wif: kept.wif, key: result.key } : null
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
 * `accept`, when given, narrows which matching key may sign (charters take
 * no key bound to another contract): a held key it refuses is passed over
 * for the sheet, and an answer it refuses is refused before it is kept.
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
  accept: (key: K) => boolean = () => true,
): Promise<{ wif: string; key: K; assertLive: () => void }> {
  const assertLive = liveSessionCheck(identityId, session)
  assertLive()
  const available = availableCriticalKey(identityId, publicKeys, use, sessionKey, accept)
  if (available) return { ...available, assertLive }
  if (listeners.size === 0) throw new Error(CRITICAL_KEY_REQUIRED)
  const answer = await ask(identityId, use)
  if (!answer) throw new CriticalKeyCancelledError()
  assertLive()
  const result = usableFor(answer.source, use) ? matchCritical(answer.wif, publicKeys) : null
  if (!result?.ok || !accept(result.key)) throw new Error(CRITICAL_KEY_REQUIRED)
  if (answer.keep) holdCriticalKey(identityId, answer.wif, answer.source)
  return { wif: answer.wif, key: result.key, assertLive }
}

/**
 * Another key `identityId`'s action needs, asked for with the same sheet
 * (`prompt` words it and checks what is typed): resolves to the text the
 * sheet's check accepted. Bound to `session` ({@link criticalKeySession}) like
 * {@link criticalKeyFor}: a sign-out or a switch of account while it is asked
 * stops the action (CriticalKeyCancelledError), as does closing the sheet.
 * Nothing is kept: the caller zeroes what it derives.
 */
export async function askForKey(identityId: string, prompt: KeyPrompt, session: number): Promise<string> {
  const assertLive = liveSessionCheck(identityId, session)
  assertLive()
  if (listeners.size === 0) throw new Error(KEY_SHEET_MISSING)
  const answer = await ask(identityId, 'moderation', prompt)
  if (!answer) throw new CriticalKeyCancelledError()
  assertLive()
  return answer.wif
}

/**
 * Closes the sheet when the request it shows is one `isOurs` recognises (say,
 * by its {@link KeyPrompt}): the action that asked is gone. A
 * {@link criticalKeyFor} request may be shared by several waiting actions, so
 * no single one of them closes it; each stops on its own session check instead.
 */
export function cancelPrompt(isOurs: (request: CriticalKeyRequest) => boolean): void {
  if (pending && isOurs(pending.request)) settle(null)
}
