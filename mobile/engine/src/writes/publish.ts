import { planPosts, publishThread, type PostToCreate, type PublishOutcome } from '@/lib/compose/publish-thread'
import { hasVisibleContent, isOverContentLimit } from '@/lib/compose/limits'
import { mediaCarriesHashes, threadRootIdOf } from '@/lib/contract-topology'
import { imageDigestForUrl } from '@/lib/media/image-digest'
import type { MediaHashes } from '@/lib/media/media-fingerprint'
import type { Post } from '@/lib/types'
import { isUnconfirmed } from '@/lib/unconfirmed-writes'
import { mediaUrlForContract } from '@/lib/utils/ipfs-gateway'
import { RpcError } from '../protocol/envelope'
import { assertId, assertMediaUrl, assertTarget, badRequest, signer, socialDoc } from './handler-kit'
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
  if (draft.mediaUrl != null) assertMediaUrl(draft.mediaUrl, 'mediaUrl')
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

/** Load what a reply or quote names, as web's composer holds it; a private (encrypted) target is not in 1.0. */
async function loadTarget(ref: TargetRef | null | undefined, load: (id: string) => Promise<Post | null>): Promise<Post | null> {
  if (!ref) return null
  const post = await load(ref.id)
  if (!post) throw new Error('The post you are responding to was not found. It may have been deleted.')
  if (post.encryptedContent !== undefined) throw new RpcError('Replying to or quoting a private post is not available here', 'NOT_SUPPORTED')
  return post
}

/** v10 posts carry the image's sha256 and dHash beside its URL; they are computed here, once, from the URL. */
async function mediaFields(url: string | null | undefined): Promise<{ mediaUrlField?: string; mediaHashes?: MediaHashes }> {
  if (!url) return {}
  const mediaUrlField = mediaUrlForContract(url)
  if (!mediaCarriesHashes()) return { mediaUrlField }
  const digest = await imageDigestForUrl(url)
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

export function createPublishHandler(load: (id: string) => Promise<Post | null>): WriteHandler<DraftDTO> {
  async function run(draft: DraftDTO, ctx: WriteRunContext): Promise<WriteResult> {
    const authorId = signer(ctx)
    const posted = postedIds(draft, ctx.ticket.documents)
    const plan = planPosts(draft.parts.map((part, index) => ({ id: String(index), content: part.text, postedPostId: posted[index] ?? undefined })), undefined, false)
    if (plan.length === 0) return { state: 'confirmed' }

    // Everything before publishThread is reads and local work: a failure there sent nothing.
    const [replyingTo, quotingPost, media] = await Promise.all([
      loadTarget(draft.replyTo, load), loadTarget(draft.quote, load), mediaFields(draft.mediaUrl),
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
    // again). Unconfirmed, the probe keeps it unprovable and points the user to resume (ENGINE §7.1).
    if (outcome.timedOut.length > 0) return { state: 'unconfirmed', documents }
    if (outcome.failedAtIndex !== null) return { state: 'failed', error: failureOf(outcome.failureError), documents }
    const unconfirmed = documents.some(doc => !doc.confirmed)
    return { state: unconfirmed ? 'unconfirmed' : 'confirmed', documents }
  }

  /**
   * "Check again": every part must have landed. A part that timed out before
   * its id was known cannot be proved either way, so the ticket stays
   * unconfirmed; resume the thread (`resume.postedIds`) once the profile shows
   * what posted.
   */
  async function probe(ticket: WriteTicket, draft: DraftDTO | undefined, kit: ProbeKit): Promise<ProbeResult> {
    if (!draft) return { state: 'unknown', error: new Error('This post can no longer be checked: its draft was not kept') }
    const posted = postedIds(draft, ticket.documents)
    const missing = draft.parts.findIndex((part, index) => !posted[index] && hasVisibleContent(part.text))
    if (missing >= 0) {
      return { state: 'unknown', error: new Error(`Part ${missing + 1} never reported an id, so it cannot be checked: see your profile, then resume the thread`) }
    }
    return kit.proveDocuments(ticket.documents)
  }

  return { run, probe, persistArgs: true }
}
