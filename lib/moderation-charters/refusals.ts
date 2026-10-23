/**
 * What a refused charters write tells the person who tried it, by consensus
 * code and by what they were doing. Pure (unit-tested). Nothing raw ever
 * reaches the page: an unknown refusal reads as "That didn't go through".
 */
import { NONCE_STORE_ERROR, PENDING_WRITE_ERROR, consensusCodeOf, extractErrorMessage, isOutcomeUnknownError } from '@/lib/error-utils'
import { CRITICAL_KEY_REQUIRED, CriticalKeyCancelledError, KEY_SHEET_MISSING } from '@/lib/auth/critical-key'

/** What was being written. */
export type CharterAction = 'reason' | 'proposal' | 'join' | 'application' | 'add-member' | 'remove-member' | 'undo-team-change' | 'charter-key'

export type CharterOutcome = 'refused' | 'uncertain' | 'cancelled'

/** A charters write that did not go through, in words for the page. */
export class CharterActionError extends Error {
  constructor(message: string, readonly outcome: CharterOutcome, readonly code: number | null = null) {
    super(message)
    this.name = 'CharterActionError'
  }
}

export const CHARTER_UNCERTAIN_MESSAGE = "The network didn't confirm this in time. It may still go through, so check before trying again."
const GENERIC = "That didn't go through. Please try again in a moment."
const WRONG_SIGNING_KEY = "That key can't sign this. Use your CRITICAL or HIGH key."
const LOW_BALANCE = "Your balance is too low for this. Top up your account's credits and try again."
const UNDO_WAITS_FOR_PENDING = 'Something you sent from this browser may still go through. Check it, then try again.'
const HAS_CHARTER_KEY = 'This account already has a charter key. Enter that key instead.'

/** Messages that depend on the action, then the ones that do not. */
const BY_ACTION: Partial<Record<CharterAction, Record<number, string>>> = {
  reason: {
    40105: 'You already have a reason with this code. Pick it from your reasons, or use another code.',
  },
  proposal: {
    40120: 'One of the reasons could not be found. Refresh and pick your reasons again.',
    40135: "This contract doesn't hold moderator elections.",
    40136: "Your charter key isn't set up yet. Set it up, then submit again.",
  },
  join: {
    40105: "You've already asked to join this team.",
    40120: 'This proposal could not be found.',
    40136: "The team's leader has no charter key, so join requests can't be sent to them.",
  },
  application: {
    40105: 'This contract already has a seated team.',
    40111: 'Applications for this contract have closed.',
    40112: "You've already applied for this contract.",
    40110: 'This contest is locked and takes no more applications.',
    40114: 'The contest deposit was not paid. Check your balance and try again.',
    40120: "One of the members you picked hasn't asked to join this proposal. Refresh the join requests and pick again.",
    40135: "Applications for this contract haven't opened yet.",
    40141: 'This contest has as many applicants as it can take.',
    10418: "The network isn't taking applications yet. Try again after the next epoch.",
  },
  'add-member': {
    40105: 'That member is already on the team.',
    40120: "That person hasn't asked to join this team.",
    41202: 'The team has added as many members as the contract allows. Take one off first.',
  },
  'remove-member': {
    40105: 'That member has already been taken off.',
    40120: 'Only members the election seated can be taken off this way.',
  },
  'charter-key': {
    40211: HAS_CHARTER_KEY,
    40206: HAS_CHARTER_KEY,
  },
}

const ANY_ACTION: Record<number, string> = {
  10421: 'The description is too long: at most 4096 bytes.',
  10422: 'The reward split must add up to 100.',
  20004: WRONG_SIGNING_KEY,
  20007: WRONG_SIGNING_KEY,
  20011: WRONG_SIGNING_KEY,
  30000: LOW_BALANCE,
  40210: LOW_BALANCE,
  40204: 'Another change from your account is still going through. Try again in a moment.',
  40203: 'Another change to your account is still going through. Try again in a moment.',
  41101: 'Only the seated leader can change the team.',
}

/** The page's message for a failed charters write: a {@link CharterActionError}. */
export function charterActionError(action: CharterAction, error: unknown): CharterActionError {
  if (error instanceof CharterActionError) return error
  // The key sheet was closed, or the sign-in the action began in ended: nothing was signed.
  if (error instanceof CriticalKeyCancelledError) return new CharterActionError('Nothing was sent.', 'cancelled')
  // Nothing was sent: another write may still land on this nonce sequence, or this browser's storage refused the nonce.
  const plain = extractErrorMessage(error)
  if (plain === CRITICAL_KEY_REQUIRED) return new CharterActionError("That key can't sign this. Use your account's CRITICAL key.", 'refused')
  if (plain === KEY_SHEET_MISSING) return new CharterActionError('Your key could not be asked for here. Reload the page, then try again.', 'refused')
  // Taking a member off or putting one back waits for every charters write this browser sent to settle: say which.
  if (plain === PENDING_WRITE_ERROR && action === 'undo-team-change') return new CharterActionError(UNDO_WAITS_FOR_PENDING, 'refused')
  if (plain === PENDING_WRITE_ERROR || plain === NONCE_STORE_ERROR) return new CharterActionError(plain, 'refused')
  const code = consensusCodeOf(error) ?? codeInMessage(error)
  if (code !== null) {
    const message = BY_ACTION[action]?.[code] ?? ANY_ACTION[code]
    if (message) return new CharterActionError(message, 'refused', code)
  }
  if (isOutcomeUnknownError(error)) return new CharterActionError(CHARTER_UNCERTAIN_MESSAGE, 'uncertain', code)
  return new CharterActionError(GENERIC, 'refused', code)
}

/** Schema refusals (JsonSchemaError, the description's and the split's own rules): the same bytes fail them on any node. */
const SCHEMA_CODES = new Set([10101, 10419, 10421, 10422])

/**
 * Whether Platform refused `error`'s transition for what its bytes are, not
 * for the state it met: on a `fresh` first send any basic-structure or
 * signature code (10000-29999), on a resend only the schema codes, since a
 * resend's other checks run against a node's version and the keys as they
 * are now (a key disabled after the first send landed, say). Not a verdict
 * on its own: some of these codes still depend on a node's version, so the
 * caller drops the bytes only once their nonce is proved unused.
 */
export function isStatelessRefusal(error: unknown, { fresh }: { fresh: boolean }): boolean {
  const code = consensusCodeOf(error) ?? codeInMessage(error)
  if (code === null) return false
  return fresh ? code >= 10000 && code < 30000 : SCHEMA_CODES.has(code)
}

/** A refusal flattened into a message keeps its code as `code=40105` or `code: 40105`. */
function codeInMessage(error: unknown): number | null {
  const match = /\bcode"?\s*[=:]\s*(\d{5})\b/i.exec(extractErrorMessage(error))
  return match ? Number(match[1]) : null
}
