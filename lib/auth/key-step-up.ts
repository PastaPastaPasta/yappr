/**
 * Step-up keys: a key the session does not hold, asked for at the moment an
 * action needs it (the MASTER key to add a charter key, a CRITICAL or HIGH key
 * to sign for the charters contract from a wallet session).
 *
 * The sheet (components/auth/key-step-up-sheet.tsx) asks; the request's own
 * `validate` checks the typed key against the identity before the sheet
 * closes, so a caller only ever gets back a key that fits. What is typed is
 * handed to the caller and kept nowhere here: never stored, never logged.
 *
 * This is a seam: the account-wide CRITICAL-key step-up (in progress on its own
 * branch, `lib/auth/critical-key.ts`) can take over the signing-key requests
 * once it lands, without the charter flow changing.
 */

export interface KeyStepUpRequest {
  identityId: string
  /** The sheet's title: what the key is about to do. */
  title: string
  /** Why the key is needed and what happens to it, in a sentence or two. */
  description: string
  /** The field's label ("Master key"). */
  label: string
  /** The key as typed: an error to show, or null when it fits. Must not throw. */
  validate: (input: string) => Promise<string | null>
}

/** The sheet was closed: the action stops before anything is signed. */
export class KeyStepUpCancelledError extends Error {
  constructor() {
    super('The key was not given')
    this.name = 'KeyStepUpCancelledError'
  }
}

/** No sheet is mounted to ask with. */
export class KeyStepUpUnavailableError extends Error {
  constructor() {
    super('No key prompt is available here')
    this.name = 'KeyStepUpUnavailableError'
  }
}

interface Pending {
  request: KeyStepUpRequest
  resolve: (input: string | null) => void
}

let pending: Pending | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function settle(input: string | null): void {
  const settled = pending
  if (!settled) return
  pending = null
  settled.resolve(input)
  notify()
}

/** For the sheet (useSyncExternalStore): subscribing also marks it mounted. */
export function subscribeKeyStepUp(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) settle(null)
  }
}

export function currentKeyStepUp(): KeyStepUpRequest | null {
  return pending?.request ?? null
}

/** The sheet's answer to `request`, already validated by it; ignored once another request replaced it. */
export function answerKeyStepUp(request: KeyStepUpRequest, input: string): void {
  if (pending?.request === request) settle(input)
}

export function cancelKeyStepUp(): void {
  settle(null)
}

/**
 * Asks for a key; resolves with the input once the request's `validate`
 * accepted it. Throws {@link KeyStepUpCancelledError} when the sheet is
 * closed and {@link KeyStepUpUnavailableError} when none is mounted. A new
 * request replaces one still open (which counts as cancelled).
 */
export function requestKeyStepUp(request: KeyStepUpRequest): Promise<string> {
  if (listeners.size === 0) return Promise.reject(new KeyStepUpUnavailableError())
  settle(null)
  return new Promise<string>((resolve, reject) => {
    pending = { request, resolve: (input) => (input === null ? reject(new KeyStepUpCancelledError()) : resolve(input)) }
    notify()
  })
}
