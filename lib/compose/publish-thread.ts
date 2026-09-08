import toast from 'react-hot-toast'
import { logger } from '@/lib/logger'
import type { Post } from '@/lib/types'
import type { PostVisibility, ThreadPost } from '@/lib/store'
import type { EncryptionOptions, EncryptionSource } from '@/lib/services/post-service'
import type { PostEmbed } from '@/lib/poll-embed'
import { extractAllTags, extractMentions } from '@/lib/post-helpers'
import { hashtagService } from '@/lib/services/hashtag-service'
import { mentionService } from '@/lib/services/mention-service'
import { extractErrorMessage, isTimeoutError } from '@/lib/error-utils'
import { hashtagsAreInline, replyLinkageTo, threadRootIdOf } from '@/lib/contract-topology'
import { resolveQuoteReference } from '@/lib/feed/resolve-quoted-posts'
import { isUnconfirmed, markUnconfirmed, settleUnconfirmed } from '@/lib/unconfirmed-writes'
import { dispatchFieldRegistered } from '@/lib/services/post-field-validation'
import type { PostingProgress } from '@/components/compose/compose-sub-components'

export interface PostToCreate {
  threadPostId: string
  content: string
  teaser?: string
  visibility?: PostVisibility
}

/** The thread posts that still need creating, with the image URL folded in where it must be. */
export function planPosts(threadPosts: ThreadPost[], imageUrl: string | undefined, mediaInEncryptedContent: boolean): PostToCreate[] {
  return threadPosts
    .filter((p) => p.content.trim().length > 0 && !p.postedPostId)
    .map((p, index) => ({
      threadPostId: p.id,
      // Only encrypted posts carry the image URL in their text.
      content: index === 0 && imageUrl && mediaInEncryptedContent ? `${p.content.trim()}\n\n${imageUrl}` : p.content.trim(),
      teaser: p.teaser?.trim(),
      visibility: p.visibility,
    }))
}

export interface PublishInput {
  authorId: string
  posts: PostToCreate[]
  replyingTo: Post | null
  quotingPost: Post | null
  /** The last post already created in an earlier attempt, for retry chaining. */
  lastPostedId: string | null
  /** Post #0 of a standalone thread from an earlier attempt. */
  knownThreadRootId: string | null
  isPrivate: boolean
  inheritedEncryption: EncryptionSource | null
  pollEmbed: PostEmbed | undefined
  mediaUrlField: string | undefined
  markSensitive: boolean
  onProgress: (progress: PostingProgress) => void
}

export interface SuccessfulPost {
  index: number
  postId: string
  content: string
  threadPostId: string
}

export interface PublishOutcome {
  successful: SuccessfulPost[]
  /** Posts whose creation timed out unverified; they may have landed. */
  timedOut: { index: number; threadPostId: string }[]
  failedAtIndex: number | null
  failureError: Error | null
  /** The user must sync private-feed keys first; nothing is reported as failed. */
  syncRequired: boolean
}

interface CreatedDocument {
  postId: string
  document: unknown
  isReply: boolean
  confirmed: boolean
}

/**
 * Create the posts of a thread one after another, each chained to the last.
 * Public follow-ups become replies to the post before them; a private post #0
 * is deliberately not chained to, so what follows stays public and top-level.
 */
export async function publishThread(input: PublishInput): Promise<PublishOutcome> {
  const { authorId, posts, replyingTo, quotingPost, lastPostedId, knownThreadRootId, isPrivate, inheritedEncryption, pollEmbed, mediaUrlField, markSensitive, onProgress } = input
  const { retryPostCreation } = await import('@/lib/retry-utils')
  const outcome: PublishOutcome = { successful: [], timedOut: [], failedAtIndex: null, failureError: null, syncRequired: false }
  const { fields: quoteFields, embed: quoteEmbed } = resolveQuoteReference(quotingPost)

  let previousPostId: string | null = lastPostedId || replyingTo?.id || null
  let threadRootId: string | null = replyingTo ? threadRootIdOf(replyingTo) : knownThreadRootId

  for (let i = 0; i < posts.length; i++) {
    const { threadPostId, content, teaser, visibility } = posts[i]
    const isThisPostPrivate = i === 0 && isPrivate
    const isThisReplyInherited = i === 0 && inheritedEncryption !== null && !isPrivate
    const progress = (status: string) => onProgress({ current: i + 1, total: posts.length, status })
    const kind = isThisReplyInherited ? 'reply' : 'post'

    progress(isThisPostPrivate || isThisReplyInherited ? `Encrypting and creating private ${kind} ${i + 1}...` : `Creating post ${i + 1} of ${posts.length}...`)
    logger.debug(`Creating post ${i + 1}/${posts.length}... (private: ${isThisPostPrivate}, inherited: ${isThisReplyInherited})`)

    let encryption: EncryptionOptions | undefined
    if (isThisReplyInherited && inheritedEncryption) {
      encryption = { type: 'inherited', source: { ownerId: inheritedEncryption.ownerId, epoch: inheritedEncryption.epoch } }
    } else if (isThisPostPrivate) {
      const { getEncryptionKeyBytes } = await import('@/lib/secure-storage')
      encryption = {
        type: 'owner',
        teaser: visibility === 'private-with-teaser' ? teaser : undefined,
        encryptionPrivateKey: getEncryptionKeyBytes(authorId) ?? undefined,
      }
    }

    // The direct target is what was clicked (i === 0) or the previous item in
    // this thread; its owner is what notification queries key on.
    const isReply = (i === 0 && !!replyingTo) || (i > 0 && !!previousPostId)
    const directTargetId = i === 0 && replyingTo ? replyingTo.id : previousPostId
    const parentOwnerId = i === 0 && replyingTo ? replyingTo.author.id : previousPostId ? authorId : undefined
    const linkage = threadRootId && directTargetId ? replyLinkageTo({ id: directTargetId, targetKind: 'reply', rootPostId: threadRootId }) : null

    // Naming a document this session created but never saw confirmed would be
    // rejected by consensus and charged for; wait for it first.
    const referenced = i === 0 ? replyingTo?.id ?? quotingPost?.id : directTargetId ?? undefined
    if (isUnconfirmed(referenced)) {
      progress(i === 0 ? 'Waiting for the post you are referencing to confirm...' : 'Waiting for the previous post to confirm...')
      if (!(await settleUnconfirmed(referenced))) {
        outcome.failedAtIndex = i
        outcome.failureError = new Error('The post this one references has not confirmed yet. Try again in a moment — nothing was lost.')
        break
      }
    }

    const result = await retryPostCreation(async (): Promise<CreatedDocument> => {
      try {
        if (isReply && linkage && parentOwnerId) {
          const { replyService } = await import('@/lib/services/reply-service')
          const reply = await replyService.createReply(authorId, content, { ...linkage, parentOwnerId }, { encryption, mediaUrl: i === 0 ? mediaUrlField : undefined })
          return { postId: reply.id, document: reply, isReply: true, confirmed: wasConfirmed(reply) }
        }
        const { postService } = await import('@/lib/services')
        const post = await postService.createPost(authorId, content, {
          ...(i === 0 ? quoteFields : {}),
          embed: i === 0 ? quoteEmbed ?? pollEmbed : undefined,
          encryption,
          sensitive: markSensitive || undefined,
          mediaUrl: i === 0 ? mediaUrlField : undefined,
        })
        return { postId: post.id, document: post, isReply: false, confirmed: wasConfirmed(post) }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('SYNC_REQUIRED:')) {
          const { useEncryptionKeyModal } = await import('@/hooks/use-encryption-key-modal')
          useEncryptionKeyModal.getState().open('sync_state', () => {
            toast('Please try posting again now that your keys are synced')
          })
          toast.error('Your private feed state needs to sync. Please enter your encryption key.')
          throw Object.assign(new Error('SYNC_REQUIRED'), { syncRequired: true })
        }
        throw error
      }
    })

    if (!result.success) {
      if ((result.error as { syncRequired?: boolean } | undefined)?.syncRequired) {
        outcome.syncRequired = true
        return outcome
      }
      // The service already tried to verify a timed-out write on Platform; a
      // retry is safe because creation is idempotent.
      if (isTimeoutError(result.error)) {
        logger.warn(`Post ${i + 1} timed out and could not be verified — may have succeeded.`)
        outcome.timedOut.push({ index: i, threadPostId })
        continue
      }
      outcome.failedAtIndex = i
      outcome.failureError = new Error(extractErrorMessage(result.error))
      break
    }

    const created = result.data
    if (!created?.postId) {
      outcome.failedAtIndex = i
      outcome.failureError = new Error(`Post ${i + 1} created but no ID returned for threading`)
      break
    }
    outcome.successful.push({ index: i, postId: created.postId, content, threadPostId })
    if (!isThisPostPrivate) {
      previousPostId = created.postId
      if (threadRootId === null) threadRootId = created.postId
    }
    // Only a write that went out unconfirmed arms the gate; the record is
    // session-wide because the optimistic card is already interactive.
    if (!created.confirmed) markUnconfirmed(created.isReply ? 'reply' : 'post', created.postId)

    progress(isThisPostPrivate ? 'Private post created!' : `Post ${i + 1} created, processing hashtags...`)
    // Encrypted content is never indexed; only a public teaser is.
    let indexable = content
    if (isThisPostPrivate) indexable = visibility === 'private-with-teaser' && teaser ? teaser : ''
    else if (isThisReplyInherited) indexable = ''
    registerIndexes(created.postId, authorId, indexable, i)

    if (i === 0) {
      window.dispatchEvent(
        new CustomEvent(created.isReply ? 'reply-created' : 'post-created', {
          detail: created.isReply
            ? { reply: created.document, replyId: created.postId, confirmed: created.confirmed }
            : { post: created.document, postId: created.postId, confirmed: created.confirmed },
        })
      )
    }
  }
  return outcome
}

function wasConfirmed(doc: unknown): boolean {
  return (doc as { __createConfirmed?: boolean }).__createConfirmed !== false
}

/** Fire-and-forget hashtag and mention index documents for a public post. */
function registerIndexes(postId: string, authorId: string, content: string, index: number): void {
  // The inline-hashtag topology (v4) carries the tag on the post itself.
  const hashtags = hashtagsAreInline() ? [] : extractAllTags(content)
  if (hashtags.length > 0) {
    hashtagService
      .createPostHashtags(postId, authorId, hashtags)
      .then((results) => {
        logger.debug(`Post ${index + 1}: Created ${results.filter(Boolean).length}/${hashtags.length} hashtag documents`)
        results.forEach((ok, i) => ok && dispatchFieldRegistered('hashtag', { postId, value: hashtags[i] }))
      })
      .catch((err) => logger.error(`Post ${index + 1}: Failed to create hashtag documents:`, err))
  }
  const mentions = extractMentions(content)
  if (mentions.length > 0) {
    mentionService
      .createPostMentionsFromUsernames(postId, authorId, mentions)
      .then((results) => {
        logger.debug(`Post ${index + 1}: Created ${results.filter(Boolean).length}/${mentions.length} mention documents`)
        results.forEach((ok, i) => ok && dispatchFieldRegistered('mention', { postId, value: mentions[i] }))
      })
      .catch((err) => logger.error(`Post ${index + 1}: Failed to create mention documents:`, err))
  }
}
