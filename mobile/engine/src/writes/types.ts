/**
 * Write tickets and engine error codes (ENGINE.md §7). Types only: the RN
 * host imports them through `type EngineApi`.
 */

export type EngineErrorCode =
  // engine and bridge
  | 'ENGINE_TIMEOUT' | 'ENGINE_RESTARTED' | 'ENGINE_UNAVAILABLE' | 'ENGINE_BUSY' | 'ENGINE_VARIANT_MISMATCH' | 'RESTART_REQUIRED'
  // a ticket whose lib call has not answered for its deadline (PRD G-3): it may still land
  | 'STILL_SENDING'
  | 'ABORTED' | 'BAD_REQUEST' | 'BAD_CURSOR' | 'NOT_SUPPORTED' | 'NOT_SIGNED_IN' | 'NOT_RETRYABLE' | 'CODEC'
  // session
  | 'KEY_INVALID' | 'KEY_WRONG_NETWORK' | 'KEY_NOT_ON_IDENTITY' | 'IDENTITY_NOT_FOUND' | 'NO_KEY'
  // Platform refused the signing key: disabled, no longer on the identity, or expired (PRD AUTH-14)
  | 'KEY_REVOKED'
  | 'KEY_EXCHANGE_TIMEOUT' | 'KEY_EXCHANGE_CANCELLED' | 'KEY_REGISTRATION_TIMEOUT'
  // a wallet sign-in whose derived auth key is disabled on the identity (PRD AUTH-14)
  | 'KEY_DISABLED'
  // App Connect: the wallet's allowance or time for Yappr ran out (renew in the wallet), or the write needs the wallet itself
  | 'RENEW_REQUIRED' | 'NEEDS_WALLET'
  // writes (classify(), from lib/error-utils.ts predicates)
  | 'MODERATION_BARRED' | 'MODERATION_NOT_SEATED' | 'TOO_LONG' | 'RULE_VIOLATION' | 'ALREADY_CLAIMED'
  | 'PARENT_TOO_YOUNG' | 'PARENT_UNCONFIRMED' | 'FEE_UNPAYABLE' | 'FEE_SHARE_MISMATCH' | 'EXPIRED' | 'CONTEST'
  | 'FEE_CHANGED' | 'NONCE_CONFLICT' | 'NOT_RECORDED' | 'PENDING_WRITE' | 'STORAGE' | 'APP_OUTDATED'
  | 'BUILD_DEFECT' | 'IMMUTABLE' | 'TARGET_GONE' | 'NOT_OWNER' | 'STALE' | 'FROZEN' | 'INSUFFICIENT_YAPP' | 'INSUFFICIENT_CREDITS'
  | 'DUPLICATE' | 'QUOTE_HAS_TEXT' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'PRIVATE_FEED_SYNC_REQUIRED' | 'UNKNOWN'
  // domain writes (M7b): the own block is gone, a followed block list still blocks
  | 'STILL_BLOCKED'
  // a report to withdraw is already gone (dismissed, or withdrawn elsewhere)
  | 'REPORT_GONE'
  // v14: a report to withdraw was resolved by the moderators, so the network keeps it
  | 'REPORT_RESOLVED'
  // the image a post names could not be read (an HTTP error, not an image, or no CORS) to fingerprint it
  | 'MEDIA_UNREADABLE'
  // a private-feed write the feed's state refused (full, moving, withdrawn, ...): `userMessage` says which, for the user
  | 'PRIVATE_FEED'
  // a private-feed write that needs this account's messaging key, which this device does not hold
  | 'NO_MESSAGING_KEY'
  // dm.startDirect (v5): the other person has no messaging key yet, so nothing can be sent to them
  | 'PEER_NO_MESSAGING'

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
  | 'follow' | 'unfollow' | 'block' | 'unblock' | 'report' | 'report.withdraw' | 'profile.update'
  | 'dm.send' | 'dm.group' | 'poll.vote' | 'block-list.follow' | 'block-list.unfollow' | 'dpns.register'
  // storefront (native store)
  | 'store.save' | 'store.item' | 'store.zone' | 'store.order' | 'store.order.status' | 'store.review' | 'store.report' | 'store.report.withdraw'
  | 'privateFeed.enable' | 'privateFeed.request' | 'privateFeed.leave' | 'privateFeed.approve' | 'privateFeed.revoke'
  | 'privateFeed.renew' | 'privateFeed.move'
  // blogs (`api/blog.ts`)
  | 'blog.create' | 'blog.update' | 'blog.delete' | 'blog.follow' | 'blog.unfollow' | 'blog.report' | 'blog.report.withdraw'
  | 'blogPost.publish' | 'blogPost.update' | 'blogPost.delete' | 'blogComment.create' | 'blogComment.delete'

export type WriteState = 'pending' | 'confirmed' | 'unconfirmed' | 'failed'

export type WriteStage = 'queued' | 'waiting-parent' | 'signing' | 'broadcasting' | 'confirming'

export interface TargetRef {
  id: string
  kind: 'post' | 'reply'
  ownerId: string
  rootPostId: string | null
}

/** A blog, post, comment or report a blog write names (for a create: its parent). */
export interface BlogTargetRef {
  blog: { type: 'blog' | 'blogPost' | 'blogComment' | 'report'; id: string }
}

export type WriteTarget = TargetRef | { identityId: string } | { conversationKey: string } | { pollId: string } | BlogTargetRef

export interface TicketDocument {
  contractId: string
  type: string
  id: string
  /** `create` names a document the write adds; `delete` one it removes. `check` proves each. */
  action: 'create' | 'delete'
  confirmed: boolean
  /** `post.publish`: the index of the thread part this document is (`DraftDTO.parts`). */
  part?: number
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
  /**
   * What the viewer should know about a write that went through (a report
   * filed without the moderators' box: `unsealed-no-key`, this device could
   * not confirm a key to the post; `unsealed-no-moderators`, no moderator can
   * read private posts yet). Absent for most writes.
   */
  notice?: WriteNotice
}

export type WriteNotice = 'unsealed-no-key' | 'unsealed-no-moderators'
