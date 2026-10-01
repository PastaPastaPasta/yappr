import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import { isUnconfirmed, settleUnconfirmed } from '@/lib/unconfirmed-writes'
import type { Post } from '@/lib/types'
import { RpcError } from '../protocol/envelope'
import { documentExists } from './lib-results'
import type { ProbeResult, WriteRunContext } from './tickets'
import type { TargetRef, TicketDocument, WriteTicket } from './types'

/**
 * What the domain write handlers (M7b) share: input checks, the identity a
 * ticket signs with, the parent-settling gate web runs before a dependent
 * write, and the probes "check again" uses.
 */

/** Base58 of 32 bytes: 43 or 44 characters. */
const IDENTITY_ID = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/

export function badRequest(message: string): RpcError {
  return new RpcError(message, 'BAD_REQUEST')
}

export function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTITY_ID.test(value)) throw badRequest(`${what} must be a base58 identifier`)
}

/** A post or reply named by the host: `{id, kind, ownerId, rootPostId}`. */
export function assertTarget(target: unknown): asserts target is TargetRef {
  const ref = target as Partial<TargetRef> | null
  if (typeof ref !== 'object' || ref === null) throw badRequest('target must be a TargetRef')
  assertId(ref.id, 'target.id')
  assertId(ref.ownerId, 'target.ownerId')
  if (ref.kind !== 'post' && ref.kind !== 'reply') throw badRequest('target.kind must be "post" or "reply"')
  if (ref.rootPostId !== null && ref.rootPostId !== undefined) assertId(ref.rootPostId, 'target.rootPostId')
}

/** The identity a ticket signs with (stamped at submit; a retry runs only for the same active account). */
export function signer(ctx: WriteRunContext): string {
  const identityId = ctx.ticket.identityId
  if (!identityId) throw new RpcError('This write has no signing account', 'NOT_SIGNED_IN')
  return identityId
}

/** A document of the social contract, for a ticket's `documents`. */
export function socialDoc(type: string, id: string, action: TicketDocument['action'], confirmed = false): TicketDocument {
  return { contractId: YAPPR_CONTRACT_ID, type, id, action, confirmed }
}

/**
 * Web's gate before a write that names `id` (`use-post-engagement.ts`
 * `settle`): a document this session created but never saw confirmed is
 * waited for first, because consensus refuses (and charges for) a reference
 * to a document that is not there. Nothing is sent while it waits, so a
 * failure here is `PARENT_UNCONFIRMED`, never "maybe sent".
 */
export async function settleTarget(ctx: WriteRunContext, id: string | undefined): Promise<void> {
  if (!isUnconfirmed(id)) return
  ctx.stage('waiting-parent')
  if (!(await settleUnconfirmed(id))) {
    throw new RpcError('This post has not confirmed yet. Try again in a moment.', 'PARENT_UNCONFIRMED')
  }
  // The store reads 'waiting-parent' as "nothing sent yet": leave it before lib's write call.
  ctx.stage('signing')
}

/**
 * A Post-shaped stand-in for a target the host named by reference, for the
 * lib helpers that read only its id, kind, author and thread root
 * (`resolveQuoteReference`, `replyLinkageTo`).
 */
export function targetStub(target: TargetRef): Post {
  return {
    id: target.id,
    targetKind: target.kind,
    ...(target.rootPostId ? { rootPostId: target.rootPostId } : {}),
    author: { id: target.ownerId, username: '', displayName: '', avatar: '', followers: 0, following: 0, joinedAt: new Date(0) },
    content: '',
    createdAt: new Date(0),
    likes: 0,
    reposts: 0,
    replies: 0,
    quotes: 0,
    views: 0,
  }
}

/** How long a second read waits before an absence counts (as the ticket store's own probe). */
let absenceRecheckMs = 2_000

/** Tests only: no 2 s wait between the two reads of an absence. */
export function setAbsenceRecheckMs(ms: number): void {
  absenceRecheckMs = ms
}

const pause = () => new Promise(resolve => setTimeout(resolve, absenceRecheckMs))

/**
 * A probe from a relation read (`isLiked`, `getBookmark`, ...): `present`
 * says whether the write's effect is visible, `expected` whether it should
 * be. One node can lag, so an answer that disagrees counts only when a
 * second read agrees with it. A read that throws proves nothing.
 *
 * Several lib reads report a failed query as "absent". Where only those
 * exist, a not-applied verdict may be wrong; the retry it allows is still
 * safe, because each of those writes checks for an existing document before
 * it creates one, and a unique index refuses a second.
 */
export async function probeRelation(present: () => Promise<boolean>, expected: boolean): Promise<ProbeResult> {
  try {
    if ((await present()) === expected) return { state: 'applied' }
    await pause()
    return (await present()) === expected ? { state: 'applied' } : { state: 'not-applied' }
  } catch (error) {
    return { state: 'unknown', error }
  }
}

/**
 * The ticket store's default proof, for handlers whose probe adds a rule of
 * its own: each unconfirmed document proved present (create) or absent
 * (delete) with proved reads, a create's absence by two reads.
 */
export async function proveDocuments(documents: TicketDocument[]): Promise<ProbeResult> {
  try {
    for (const doc of documents.filter(doc => !doc.confirmed)) {
      let exists = await documentExists(doc)
      if (!exists && doc.action === 'create') {
        await pause()
        exists = await documentExists(doc)
      }
      if (exists !== (doc.action === 'create')) return { state: 'not-applied' }
    }
    return { state: 'applied' }
  } catch (error) {
    return { state: 'unknown', error }
  }
}

/** The post or reply a ticket names, for probes. */
export function ticketTarget(ticket: WriteTicket): TargetRef {
  const target = ticket.target
  if (!target || !('kind' in target)) throw new Error('This write names no post')
  return target
}

/** The account a ticket names (follow, block), for probes. */
export function ticketIdentity(ticket: WriteTicket): string {
  const target = ticket.target
  if (!target || !('identityId' in target)) throw new Error('This write names no account')
  return target.identityId
}
