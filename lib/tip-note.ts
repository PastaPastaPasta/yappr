/**
 * The public note a YAPP tip carries.
 *
 * A token transfer is proved end to end — Platform writes a `transfer` document
 * into the system token-history contract, owned by the sender, carrying the
 * exact amount. What the chain does NOT know is *what* the transfer was for:
 * nothing binds a transfer to a post. The sender's own `publicNote` is the only
 * link, and it is signed by the sender along with the amount and the recipient,
 * so it proves "this sender said this transfer was for that post" and no more.
 *
 * Encoding (the whole note, `publicNote` on the transfer transition):
 *
 *     yappr:tip:v1:post:<base58 postId>
 *     yappr:tip:v1:reply:<base58 replyId>[\n<message>]
 *
 * The `v1` segment is a version so a later encoding can be added without
 * old clients mis-reading it; a note that does not start with the exact
 * `yappr:tip:v1:` prefix is not one of ours and is ignored.
 */

import bs58 from 'bs58'

/** Which social doctype the tipped item is. */
export type TipTargetKind = 'post' | 'reply'

export interface TipNote {
  kind: TipTargetKind
  /** Base58 id of the tipped post or reply. */
  targetId: string
  /** Optional free-text message the tipper signed alongside the amount. */
  message: string
}

/** `publicNote` maxLength on the token-history `transfer` doctype. */
export const TIP_NOTE_MAX_LENGTH = 2048
/** Message cap, kept well inside the note limit and matching the old tip UI. */
export const TIP_MESSAGE_MAX_LENGTH = 280

const PREFIX = 'yappr:tip:v1:'
const KINDS: readonly TipTargetKind[] = ['post', 'reply']

/** True when `value` is a 32-byte base58 identifier. */
function isIdentifier(value: string): boolean {
  try {
    return bs58.decode(value).length === 32
  } catch {
    return false
  }
}

/**
 * The `publicNote` for a tip on `targetId`. Throws on a target that is not a
 * base58 identifier rather than signing a note nothing can resolve.
 */
export function encodeTipNote(kind: TipTargetKind, targetId: string, message?: string): string {
  if (!isIdentifier(targetId)) {
    throw new Error(`Invalid tip target: ${targetId} is not a base58 identifier`)
  }
  const header = `${PREFIX}${kind}:${targetId}`
  const trimmed = (message ?? '').trim()
  if (!trimmed) return header
  // Never sign a note the doctype would reject: the message is capped by both
  // the UI limit and whatever room the header leaves inside `maxLength`.
  const room = Math.min(TIP_MESSAGE_MAX_LENGTH, TIP_NOTE_MAX_LENGTH - header.length - 1)
  // trimEnd after slicing: the cut can land mid-space and re-introduce the
  // trailing whitespace the trim above removed.
  const body = trimmed.slice(0, room).trimEnd()
  if (!body) return header
  return `${header}\n${body}`
}

/**
 * Parse a transfer's `publicNote`. Returns null for anything that is not a
 * well-formed v1 tip note — a free-text note, another app's note, or a note
 * naming something that is not an identifier.
 */
export function parseTipNote(note: unknown): TipNote | null {
  if (typeof note !== 'string' || !note.startsWith(PREFIX)) return null

  const newline = note.indexOf('\n')
  const header = newline === -1 ? note : note.slice(0, newline)
  const message = newline === -1 ? '' : note.slice(newline + 1).trim()

  const rest = header.slice(PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator === -1) return null

  const kind = rest.slice(0, separator) as TipTargetKind
  const targetId = rest.slice(separator + 1)
  if (!KINDS.includes(kind) || !isIdentifier(targetId)) return null

  return { kind, targetId, message: message.slice(0, TIP_MESSAGE_MAX_LENGTH) }
}
