import { planPosts, publishThread, type PostToCreate, type PublishOutcome } from '@/lib/compose/publish-thread'
import { hasVisibleContent, isOverContentLimit } from '@/lib/compose/limits'
import { mediaCarriesHashes, threadRootIdOf } from '@/lib/contract-topology'
import { extractErrorMessage } from '@/lib/error-utils'
import { imageDigestForUrl } from '@/lib/media/image-digest'
import type { MediaHashes } from '@/lib/media/media-fingerprint'
import type { Post } from '@/lib/types'
import { isUnconfirmed } from '@/lib/unconfirmed-writes'
import { mediaUrlForContract } from '@/lib/utils/ipfs-gateway'
import { RpcError } from '../protocol/envelope'
import { assertId, assertMediaUrl, assertTarget, badRequest, characters, settleTarget, signer, socialDoc } from './handler-kit'
import { NotSentError, type ProbeKit, type ProbeResult, type WriteHandler, type WriteResult, type WriteRunContext } from './tickets'
import type { TargetRef, TicketDocument, WriteStage, WriteTicket } from './types'

/**
 * `posts.publish` (ENGINE.md §6.3, §7.1): a post, reply, quote or thread of
 * up to 10 parts, through web's own `planPosts` → `publishThread`
 * (`components/compose/compose-modal.tsx` `handlePost`), public only (private
 * posts and polls are not in 1.0), with an image URL hosted elsewhere and no
 * upload.
 */

/** `compose-modal.tsx` `canAddThread`. */
const MAX_THREAD_PARTS = 10
/** `post.mediaUrl` / `reply.mediaUrl` `maxLength` (v2 and v10), as stored (`mediaUrlForContract`). */
const MAX_MEDIA_URL = 512

export interface DraftDTO {
  /** 1–10 parts; a reply or a quote has exactly one. Parts without visible text are skipped, as on web. */
  parts: { text: string }[]
  replyTo?: TargetRef | null
  quote?: TargetRef | null
  /** The NSFW flag for the author's own thread (never applied to a reply to someone else's post, as on web). */
  sensitive?: boolean
  /** An image already hosted (http(s):// or ipfs://), on the first part. 1.0 has no upload. */
  mediaUrl?: string | null
  /**
   * Resume a thread after a partial failure: the ids of the parts already
   * posted, by part index (`null` for those still to post), as the failed
   * ticket's `documents[].part` name them. `writes.retry` resumes on its own.
   */
  resume?: { postedIds: (string | null)[] } | null
}

/** Check a draft before a ticket exists: a bad one rejects with `BAD_REQUEST`. */
export function validateDraft(draft: DraftDTO): void {
  if (typeof draft !== 'object' || draft === null || !Array.isArray(draft.parts)) throw badRequest('draft.parts must be an array')
  const { parts } = draft
  if (parts.length < 1 || parts.length > MAX_THREAD_PARTS) throw badRequest(`A post has 1 to ${MAX_THREAD_PARTS} parts`)
  if (parts.some(part => typeof part?.text !== 'string')) throw badRequest('Every part needs a text')
  if (draft.replyTo) assertTarget(draft.replyTo)
  if (draft.quote) assertTarget(draft.quote)
  if (draft.replyTo && draft.quote) throw badRequest('A post replies or quotes, not both')
  if ((draft.replyTo || draft.quote) && parts.length > 1) throw badRequest('A reply or a quote cannot be a thread')
  if (draft.mediaUrl != null) {
    assertMediaUrl(draft.mediaUrl, 'mediaUrl')
    // Over the contract's limit it would be refused after the ticket, every time: refuse it here.
    if (characters(mediaUrlForContract(draft.mediaUrl)) > MAX_MEDIA_URL) throw badRequest(`mediaUrl is over ${MAX_MEDIA_URL} characters`)
  }
  const posted: unknown = draft.resume ? draft.resume.postedIds : []
  if (!Array.isArray(posted) || posted.length > parts.length) throw badRequest('resume.postedIds must name at most one id per part')
  posted.forEach((id, index) => { if (id !== null) assertId(id, `resume.postedIds[${index}]`) })
  const unposted = parts.filter((part, index) => !posted[index] && hasVisibleContent(part.text))
  if (unposted.length === 0) throw badRequest('Nothing to post')
  // Characters, and on v10 UTF-8 bytes too: the contract refuses either overage (compose-modal `hasOverLimit`).
  if (unposted.some(part => isOverContentLimit(part.text.trim()))) throw badRequest('A part is over the length limit')
}

/** Part index → posted id: the draft's `resume`, then what this ticket already posted (a retry). */
function postedIds(draft: DraftDTO, documents: TicketDocument[]): (string | null)[] {
  const posted = draft.parts.map((_, index) => draft.resume?.postedIds[index] ?? null)
  for (const doc of documents) {
    if (doc.action === 'create' && doc.part !== undefined) posted[doc.part] = doc.id
  }
  return posted
}

/** One of the author's own posts or replies, as publish's probe compares them with a draft's parts. */
export interface OwnDocument {
  id: string
  type: 'post' | 'reply'
  content: string
  /** `$createdAt`, epoch ms. */
  createdAt: number
  /** A reply's direct parent. */
  parentId: string | null
  /** The post or reply a post quotes. */
  quotedId: string | null
}

/**
 * The author's newest posts and replies, by proved reads that throw when
 * they cannot tell. `completeSince` is the time (epoch ms, the chain's)
 * from which they hold every one: 0 unless a read hit its limit, else the
 * newest of the oldest dates the capped reads reached. No lower date bound
 * is asked for: a device clock ahead of the chain's then cannot hide a post.
 */
export type FindOwnDocuments = (authorId: string) => Promise<{ documents: OwnDocument[]; completeSince: number }>

/**
 * How far before the ticket a found part may be dated: the chain dates a
 * document by its block, after the ticket, unless the device clock runs
 * ahead of the chain's. Kept short, so another post of the same words made
 * just before (from web, or another device) is not taken for this one.
 */
const FOUND_SKEW_MS = 60_000
/**
 * How far back the reads must reach to prove a part absent. Also the margin
 * by which every other post of the same words must predate the ticket for
 * the one candidate in the window to count as found: one older than this
 * is an earlier post of the same words, not this part.
 */
const SEARCH_BACK_MS = 60 * 60_000
/**
 * How long after the attempt stopped running a part not found counts as
 * absent: a transition that went out executes within a block or two (lib's
 * `identity-nonce.ts`), so after this it is not still on its way.
 */
export const ABSENCE_AFTER_MS = 2 * 60_000

type PartSearch = { found: TicketDocument[]; absent: number; unclear: string | null }

/**
 * Look for the parts no ticket document names (an engine restart, or a
 * timeout, cut the write short before lib said their ids) among the
 * author's own documents, by their text and where they hang. A part found
 * once, with no other post of the same words from the hour before, is
 * named; a part whose text is nowhere is absent; anything else (a recent
 * post of the same words, two candidates, a capped read) is unclear.
 */
function searchParts(plan: PostToCreate[], draft: DraftDTO, ticket: WriteTicket, own: Awaited<ReturnType<FindOwnDocuments>>): PartSearch {
  const result: PartSearch = { found: [], absent: 0, unclear: null }
  const earliest = ticket.createdAt.getTime() - FOUND_SKEW_MS
  const horizon = ticket.createdAt.getTime() - SEARCH_BACK_MS
  const complete = own.completeSince <= horizon
  const used = new Set<string>()
  let previous: string | null | undefined
  plan.forEach((part, index) => {
    // Where this part hangs, when that is known: the post replied to, the posted part it follows,
    // the part found before it; a first part with neither is a top-level post.
    const parent = index === 0 && draft.replyTo ? draft.replyTo.id : part.predecessorPostedId ?? (index === 0 ? null : previous)
    const quoted = index === 0 && draft.quote ? draft.quote.id : null
    const sameText = own.documents.filter(doc => doc.content === part.content)
    const matches = sameText.filter(doc =>
      !used.has(doc.id) &&
      doc.createdAt >= earliest &&
      (parent === undefined || (parent === null ? doc.type === 'post' && doc.parentId === null : doc.parentId === parent)) &&
      (quoted === null || doc.quotedId === quoted))
    // The same words posted well before the attempt (last week's "gm") cannot be this part; ones
    // from the hour before could be, with a device clock ahead of the chain's. Absence stays strict:
    // any post of the same words keeps a part from being proved absent.
    const recent = sameText.filter(doc => !used.has(doc.id) && doc.createdAt >= horizon)
    previous = undefined
    if (matches.length === 1 && recent.length === 1) {
      const [doc] = matches
      used.add(doc.id)
      previous = doc.id
      result.found.push({ ...socialDoc(doc.type, doc.id, 'create', true), part: Number(part.threadPostId) })
    } else if (sameText.length === 0 && complete) {
      result.absent++
    } else {
      result.unclear ??= `Check your profile to see whether part ${Number(part.threadPostId) + 1} posted.`
    }
  })
  return result
}

/** Load what a reply or quote names, as web's composer holds it; a private (encrypted) target is not in 1.0. */
async function loadTarget(ref: TargetRef | null | undefined, load: (id: string) => Promise<Post | null>): Promise<Post | null> {
  if (!ref) return null
  const post = await load(ref.id)
  if (!post) throw new Error('The post you are responding to was not found. It may have been deleted.')
  if (post.encryptedContent !== undefined) throw new RpcError('Replying to or quoting a private post is not available here', 'NOT_SUPPORTED')
  return post
}

/**
 * Whether a fingerprint failure is the link's own: its host refuses it (lib's
 * `(HTTP 4xx)`, bar 408 and 429, which pass), or what it serves is not an
 * image this WebView decodes (`createImageBitmap`'s InvalidStateError).
 * Anything else (a fetch that failed in transit, a 5xx, a canvas failure)
 * may pass, so it is classified like any error: a host with no CORS headers
 * fails as a network error too, since fetch() can't tell the two apart.
 */
function linkUnreadable(error: unknown): boolean {
  const message = extractErrorMessage(error)
  const status = /\(HTTP (\d{3})\)/.exec(message)?.[1]
  if (status !== undefined) {
    const code = Number(status)
    return code >= 400 && code < 500 && code !== 408 && code !== 429
  }
  return (error as { name?: unknown } | null)?.name === 'InvalidStateError' || /\bdecode/i.test(message)
}

/**
 * The image at `url`, fingerprinted. When the link itself is at fault
 * (`linkUnreadable`), the post fails `MEDIA_UNREADABLE` before anything is
 * sent: posting the same link again fails the same way, so the user fixes
 * the link instead (QA D-L3a-012).
 */
async function digestOf(url: string): ReturnType<typeof imageDigestForUrl> {
  try {
    return await imageDigestForUrl(url)
  } catch (error) {
    if (linkUnreadable(error)) throw new RpcError(extractErrorMessage(error), 'MEDIA_UNREADABLE')
    throw error
  }
}

/** v10 posts carry the image's sha256 and dHash beside its URL; they are computed here, once, from the URL. */
async function mediaFields(url: string | null | undefined): Promise<{ mediaUrlField?: string; mediaHashes?: MediaHashes }> {
  if (!url) return {}
  const mediaUrlField = mediaUrlForContract(url)
  if (!mediaCarriesHashes()) return { mediaUrlField }
  const digest = await digestOf(url)
  return { mediaUrlField, mediaHashes: { mediaHash: digest.hash, mediaFingerprint: digest.fingerprint } }
}

/**
 * The documents `publishThread` created, by part. Whether a part became a
 * reply or a top-level post follows `publishThread`'s own chaining: a part
 * is a reply when it has a direct target (the post replied to, the part it
 * follows, or the last item created) and the thread has a root.
 */
function createdDocuments(outcome: PublishOutcome, plan: PostToCreate[], replyingTo: Post | null, knownRootId: string | null): TicketDocument[] {
  const created = new Map(outcome.successful.map(success => [success.index, success.postId]))
  const documents: TicketDocument[] = []
  let previous: string | null = null
  let root = replyingTo ? threadRootIdOf(replyingTo) : knownRootId
  plan.forEach((part, index) => {
    const direct: string | null = index === 0 && replyingTo ? replyingTo.id : part.predecessorPostedId ?? previous
    previous = direct
    const id = created.get(index)
    if (!id) return
    // markUnconfirmed records only where references are enforced (v9/v10); v2 reports every part confirmed.
    documents.push({ ...socialDoc(direct && root ? 'reply' : 'post', id, 'create', !isUnconfirmed(id)), part: Number(part.threadPostId) })
    previous = id
    root ??= id
  })
  return documents
}

/** `publishThread`'s refusal to reference an unconfirmed parent, as the engine code for it. */
function failureOf(error: Error | null): unknown {
  const message = error?.message ?? 'Post creation failed'
  return message.startsWith('The post this one references has not confirmed yet')
    ? new RpcError(message, 'PARENT_UNCONFIRMED')
    : error ?? new Error(message)
}

export function createPublishHandler(load: (id: string) => Promise<Post | null>, findOwn: FindOwnDocuments): WriteHandler<DraftDTO> {
  async function run(draft: DraftDTO, ctx: WriteRunContext): Promise<WriteResult> {
    const authorId = signer(ctx)
    const posted = postedIds(draft, ctx.ticket.documents)
    const plan = planPosts(draft.parts.map((part, index) => ({ id: String(index), content: part.text, postedPostId: posted[index] ?? undefined })), undefined, false)
    if (plan.length === 0) return { state: 'confirmed' }

    // The image goes on the first part. lib puts it on the first part it creates, so a resume past
    // that part (a retry, or `resume.postedIds`) must not carry it onto the next one.
    const firstPart = draft.parts.findIndex(part => hasVisibleContent(part.text))
    const mediaUrl = firstPart >= 0 && posted[firstPart] ? null : draft.mediaUrl

    // A reply or quote of a post this session just made waits for it, as engage writes do
    // (`settleTarget`): queued, rather than refused by lib's shorter wait. A resume past the first
    // part names it no more.
    const referenced = draft.replyTo?.id ?? draft.quote?.id
    if (referenced && !posted[0]) await settleTarget(ctx, referenced)

    // Everything before publishThread is reads and local work: a failure there sent nothing.
    const [replyingTo, quotingPost, media] = await Promise.all([
      loadTarget(draft.replyTo, load), loadTarget(draft.quote, load), mediaFields(mediaUrl),
    ]).catch((error: unknown) => { throw new NotSentError(error) })

    const before = posted.filter(Boolean).length
    let stage: WriteStage | null = null
    const knownRootId = posted[0] ?? null
    const outcome = await publishThread({
      authorId,
      posts: plan,
      replyingTo,
      quotingPost,
      knownThreadRootId: knownRootId,
      isPrivate: false,
      inheritedEncryption: null,
      pollEmbed: undefined,
      mediaUrlField: media.mediaUrlField,
      mediaHashes: media.mediaHashes,
      markSensitive: draft.sensitive === true,
      onProgress: ({ current, total, status }) => {
        const next: WriteStage = status.startsWith('Waiting') ? 'waiting-parent' : 'broadcasting'
        if (next !== stage) ctx.stage(stage = next)
        ctx.progress(before + current - 1, before + total)
      },
      // On the ticket at once, not only once publishThread returns: a restart or a kill mid-thread
      // must still know which parts landed, so Check again can prove them and Edit never reposts them.
      onCreated: ({ index, postId, isReply }) => {
        try {
          ctx.documents([{ ...socialDoc(isReply ? 'reply' : 'post', postId, 'create', !isUnconfirmed(postId)), part: Number(plan[index].threadPostId) }])
        } catch {
          // The ticket is gone (dismissed): the final documents below are what count.
        }
      },
    })

    // publishThread creates a part right after waiting for its parent, with no progress call
    // between: a failure is never "proved not sent" (the store's reading of 'waiting-parent').
    if (stage !== 'broadcasting') ctx.stage('broadcasting')
    const documents = createdDocuments(outcome, plan, replyingTo, knownRootId)
    ctx.progress(before + documents.length, before + plan.length)
    if (outcome.syncRequired) {
      return { state: 'failed', error: new RpcError('Private feed keys need syncing', 'PRIVATE_FEED_SYNC_REQUIRED'), documents }
    }
    // A part that timed out may have landed with no id known: never `failed` (a retry would post it
    // again). Unconfirmed, the probe looks for it by its text (ENGINE §7.2).
    if (outcome.timedOut.length > 0) return { state: 'unconfirmed', documents }
    if (outcome.failedAtIndex !== null) return { state: 'failed', error: failureOf(outcome.failureError), documents }
    const unconfirmed = documents.some(doc => !doc.confirmed)
    return { state: unconfirmed ? 'unconfirmed' : 'confirmed', documents }
  }

  /** The parts no document names, looked for among the author's own documents. */
  async function search(ticket: WriteTicket, plan: PostToCreate[], draft: DraftDTO): Promise<PartSearch> {
    const authorId = ticket.identityId
    if (!authorId) return { found: [], absent: 0, unclear: 'This post has no author to look under' }
    return searchParts(plan, draft, ticket, await findOwn(authorId))
  }

  /**
   * "Check again": every part must have landed. The documents the ticket
   * names are proved by id. A part with no id (an engine restart, or a
   * timeout, cut the write short before lib said it) is looked for by its
   * text among the author's own posts and replies: found, it is named and
   * counts as landed; nowhere on two reads, once the attempt stopped long
   * enough ago that nothing of it is still on its way (`ABSENCE_AFTER_MS`),
   * it is absent, and the write may be retried (the rest of it, for a
   * thread). Anything else stays unproved: never a resend that could post it
   * twice.
   */
  async function probe(ticket: WriteTicket, draft: DraftDTO | undefined, kit: ProbeKit): Promise<ProbeResult> {
    if (!draft) return { state: 'unknown', error: new Error('This post can no longer be checked: its draft was not kept') }
    const posted = postedIds(draft, ticket.documents)
    const plan = planPosts(draft.parts.map((part, index) => ({ id: String(index), content: part.text, postedPostId: posted[index] ?? undefined })), undefined, false)
    if (plan.length === 0) return kit.proveDocuments(ticket.documents)

    const named = ticket.documents.filter(doc => !doc.confirmed)
    const proved: ProbeResult = named.length > 0 ? await kit.proveDocuments(named) : { state: 'applied' }
    if (proved.state === 'unknown') return proved
    // Named documents proved present are confirmed now, so a retry of the rest never posts them again.
    const present = proved.state === 'applied' ? named.map(doc => ({ ...doc, confirmed: true })) : []
    let found = await search(ticket, plan, draft)
    if (!found.unclear && found.absent > 0) {
      const since = kit.sinceSettled()
      if (since === null || since < ABSENCE_AFTER_MS) {
        const error = new Error('Not found yet: a post sent just before it was cut short can take a moment to show')
        return { state: 'unknown', error, documents: [...present, ...found.found] }
      }
      // One node can lag: absent only when a second read agrees.
      await kit.recheckDelay()
      found = await search(ticket, plan, draft)
    }
    const documents = [...present, ...found.found]
    if (found.unclear) return { state: 'unknown', error: new Error(found.unclear), documents }
    if (proved.state === 'applied' && found.absent === 0) return { state: 'applied', documents }
    return { state: 'not-applied', documents }
  }

  // run() reports 'waiting-parent' or 'broadcasting' (publishThread's progress) before lib's first write.
  return { run, probe, persistArgs: true, stagedSends: true }
}
