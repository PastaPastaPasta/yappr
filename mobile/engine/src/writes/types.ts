/**
 * Write tickets and engine error codes (ENGINE.md §7). Types only: the RN
 * host imports them through `type EngineApi`.
 */

export type EngineErrorCode =
  // engine and bridge
  | 'ENGINE_TIMEOUT' | 'ENGINE_RESTARTED' | 'ENGINE_UNAVAILABLE' | 'ENGINE_BUSY' | 'ENGINE_VARIANT_MISMATCH'
  | 'ABORTED' | 'BAD_REQUEST' | 'BAD_CURSOR' | 'NOT_SUPPORTED' | 'NOT_SIGNED_IN' | 'NOT_RETRYABLE' | 'CODEC'
  // session
  | 'KEY_INVALID' | 'KEY_WRONG_NETWORK' | 'KEY_NOT_ON_IDENTITY' | 'IDENTITY_NOT_FOUND' | 'NO_KEY'
  | 'KEY_EXCHANGE_TIMEOUT' | 'KEY_EXCHANGE_CANCELLED' | 'KEY_REGISTRATION_TIMEOUT'
  // writes (classify(), from lib/error-utils.ts predicates)
  | 'MODERATION_BARRED' | 'MODERATION_NOT_SEATED' | 'TOO_LONG' | 'RULE_VIOLATION' | 'ALREADY_CLAIMED'
  | 'PARENT_TOO_YOUNG' | 'PARENT_UNCONFIRMED' | 'FEE_UNPAYABLE' | 'FEE_SHARE_MISMATCH' | 'EXPIRED' | 'CONTEST'
  | 'FEE_CHANGED' | 'NONCE_CONFLICT' | 'NOT_RECORDED' | 'PENDING_WRITE' | 'STORAGE' | 'APP_OUTDATED'
  | 'BUILD_DEFECT' | 'IMMUTABLE' | 'TARGET_GONE' | 'NOT_OWNER' | 'STALE' | 'FROZEN' | 'INSUFFICIENT_YAPP'
  | 'DUPLICATE' | 'QUOTE_HAS_TEXT' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'PRIVATE_FEED_SYNC_REQUIRED' | 'UNKNOWN'

/**
 * What is known about a write that did not confirm:
 * - `refused`: Platform judged it and refused it; it never executes.
 * - `unknown`: it may have landed (a timeout, an already-exists, an engine restart).
 * - `not-sent`: it never left the device.
 * - `not-recorded`: it was proved absent.
 * - `local`: the engine refused it before lib ran.
 */
export type WriteOutcome = 'refused' | 'unknown' | 'not-sent' | 'not-recorded' | 'local'

export interface EngineErrorData {
  code: EngineErrorCode
  /** The five-digit consensus code (`consensusCodeOf`), when the error carries one. */
  consensusCode: number | null
  outcome: WriteOutcome
  retryable: boolean
  /** `categorizeError(err)`: the web's copy, verbatim. */
  userMessage: string
}

export type WriteOp =
  | 'post.publish' | 'post.delete' | 'like' | 'unlike' | 'repost' | 'unrepost' | 'bookmark' | 'unbookmark'
  | 'follow' | 'unfollow' | 'block' | 'unblock' | 'report' | 'profile.update'
  | 'dm.send' | 'dm.group'

export type WriteState = 'pending' | 'confirmed' | 'unconfirmed' | 'failed'

export type WriteStage = 'queued' | 'waiting-parent' | 'signing' | 'broadcasting' | 'confirming'

export interface TargetRef {
  id: string
  kind: 'post' | 'reply'
  ownerId: string
  rootPostId: string | null
}

export type WriteTarget = TargetRef | { identityId: string } | { conversationKey: string }

export interface TicketDocument {
  contractId: string
  type: string
  id: string
  /** `create` names a document the write adds; `delete` one it removes. `check` proves each. */
  action: 'create' | 'delete'
  confirmed: boolean
}

export interface WriteTicket {
  id: string
  op: WriteOp
  /** The identity that signs it. `writes.list` shows only the active account's tickets. */
  identityId: string | null
  state: WriteState
  /** Set while `pending`. */
  stage: WriteStage | null
  target: WriteTarget | null
  documents: TicketDocument[]
  /** Threads: parts posted so far. */
  progress: { done: number; total: number } | null
  /** Set when failed, and when unconfirmed after a restart or a check. */
  error: EngineErrorData | null
  /** `writes.retry` is allowed (ENGINE.md §7.2): never blindly, only when the write is proved not to have landed. */
  retryable: boolean
  createdAt: Date
  updatedAt: Date
  lastCheckedAt: Date | null
}
