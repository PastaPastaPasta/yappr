import { YAPPR_CONTRACT_ID } from '@/lib/constants'
import { isUnconfirmed, settleUnconfirmed } from '@/lib/unconfirmed-writes'
import { RpcError } from '../protocol/envelope'
import { badRequest, isIdentityId } from '../dto/hydrate'
import type { WriteHandler, WriteRunContext } from './tickets'
import type { TargetRef, TicketDocument, WriteTicket } from './types'

/**
 * What the domain write handlers (M7b) share: input checks, the identity a
 * ticket signs with, the parent-settling gate web runs before a dependent
 * write, and the relation probe "check again" uses.
 */

export { badRequest }

export function assertId(value: unknown, what: string): asserts value is string {
  if (!isIdentityId(value)) throw badRequest(`${what} must be a base58 identifier`)
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

const HOSTED_URL = /^(https?|ipfs):\/\/\S+$/

/** An image already hosted somewhere (posts' `mediaUrl`, avatars, banners): http(s):// or ipfs://. */
export function assertMediaUrl(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !HOSTED_URL.test(value)) throw badRequest(`${what} must be an http(s):// or ipfs:// URL`)
}

/** Code points, as a contract's `maxLength` counts them. */
export const characters = (text: string): number => Array.from(text).length

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
 * How many of lib's waits (`settleUnconfirmed`, up to about 18 s each) a
 * write spends on a target this session created before it gives up: about
 * two minutes, the time a post that went out takes to show at the latest.
 */
export const PARENT_WAIT_ROUNDS = 6

/**
 * Web's gate before a write that names `id` (`use-post-engagement.ts`
 * `settle`): a document this session created but never saw confirmed is
 * waited for first, because consensus refuses (and charges for) a reference
 * to a document that is not there. The write is queued behind it (its
 * ticket stays `pending`, each round a word that restarts its deadline), so
 * a like or reply on a post that is still on its way just goes once the post
 * does (UX_SPEC §5.4). Nothing is sent while it waits, so a target that
 * never shows is `PARENT_UNCONFIRMED`, never "maybe sent".
 */
export async function settleTarget(ctx: WriteRunContext, id: string): Promise<void> {
  if (!isUnconfirmed(id)) return
  let landed = false
  for (let round = 0; round < PARENT_WAIT_ROUNDS && !landed; round++) {
    ctx.stage('waiting-parent')
    landed = await settleUnconfirmed(id)
  }
  if (!landed) throw new RpcError('The post this write names never showed up, so nothing was sent.', 'PARENT_UNCONFIRMED')
  // The store reads 'waiting-parent' as "nothing sent yet": leave it before lib's write call.
  ctx.stage('signing')
}

/**
 * A probe from a relation read (`isLiked`, `getBookmark`, ...): `present`
 * says whether the write's effect is visible to the ticket's signer,
 * `expected` whether it should be. One node can lag, so an answer that
 * disagrees counts only when a second read agrees with it. A read that
 * throws proves nothing.
 *
 * Several lib reads report a failed query as "absent". Where only those
 * exist, a not-applied verdict may be wrong; the retry it allows is still
 * safe, because each of those writes checks for an existing document before
 * it creates one, and a unique index refuses a second.
 */
export function relationProbe<A>(
  present: (probe: { viewer: string; ticket: WriteTicket; args: A | undefined }) => Promise<boolean>,
  expected: boolean,
): NonNullable<WriteHandler<A>['probe']> {
  return async (ticket, args, kit) => {
    const read = () => present({ viewer: ticket.identityId ?? '', ticket, args })
    try {
      if ((await read()) === expected) return { state: 'applied' }
      await kit.recheckDelay()
      return (await read()) === expected ? { state: 'applied' } : { state: 'not-applied' }
    } catch (error) {
      return { state: 'unknown', error }
    }
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
