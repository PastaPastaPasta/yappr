import { logger } from '@/lib/logger'
import { TtlMap } from '@/lib/caches/ttl-map'
import { hashtagService } from './hashtag-service'
import { mentionService } from './mention-service'
import { dpnsService } from './dpns-service'
import { extractAllTags, extractMentions, normalizeDpnsUsername } from '../post-helpers'
import { hashtagsAreInline } from '../contract-topology'

export type FieldValidationStatus = 'pending' | 'valid' | 'invalid'

/** The two secondary-index fields a post carries that can fail to be written. */
export type PostFieldKind = 'hashtag' | 'mention'

interface PostFieldValidatorOptions {
  kind: PostFieldKind
  /** Values in post content that ought to have an index document, in storage form. */
  extract: (content: string) => string[]
  /** The values that do have an index document for this post. */
  fetchRegistered: (postId: string) => Promise<Set<string>>
  /**
   * True when the contract has no secondary document to validate against, in
   * which case every value is reported valid: nothing can have failed to write.
   */
  isInline?: () => boolean
}

const CACHE_TTL = 5 * 60 * 1000
const BATCH_DELAY_MS = 10
const IN_FLIGHT_LINGER_MS = 100

/**
 * Validates that a post's secondary index documents (postHashtag, postMention)
 * were actually written. Content is the source of truth for what SHOULD exist;
 * the chain says what DOES. Fails open: when the registered set cannot be
 * fetched, every value reports as valid and nothing is cached, so a healthy
 * post is never flagged and the next look retries.
 *
 * One instance per field kind. Results are cached per post, callers within a
 * 10ms window are batched, and in-flight fetches are shared.
 */
export class PostFieldValidator {
  readonly kind: PostFieldKind
  readonly extract: (content: string) => string[]
  private readonly fetchRegistered: (postId: string) => Promise<Set<string>>
  private readonly isInline: () => boolean

  private cache = new TtlMap<string, Set<string>>(CACHE_TTL)
  /** `null` is delivered to waiters when the fetch failed. */
  private pending = new Map<string, Array<(registered: Set<string> | null) => void>>()
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight = new Map<string, Promise<Set<string> | null>>()

  constructor(options: PostFieldValidatorOptions) {
    this.kind = options.kind
    this.extract = options.extract
    this.fetchRegistered = options.fetchRegistered
    this.isInline = options.isInline ?? (() => false)
  }

  /** Status of every value in `content`, keyed by the value's storage form. */
  async validatePost(postId: string, content: string): Promise<Map<string, 'valid' | 'invalid'>> {
    const values = this.extract(content)
    const result = new Map<string, 'valid' | 'invalid'>()
    if (values.length === 0) return result

    if (this.isInline()) {
      for (const value of values) result.set(value, 'valid')
      return result
    }

    const registered = await this.registeredFor(postId)
    for (const value of values) result.set(value, !registered || registered.has(value) ? 'valid' : 'invalid')
    return result
  }

  /**
   * Drop the cached result for a post, e.g. after a value was registered. A
   * fetch already in flight is dropped too: it started before the write and
   * would hand back the pre-registration set.
   */
  invalidate(postId: string): void {
    this.cache.delete(postId)
    this.inFlight.delete(postId)
  }

  private registeredFor(postId: string): Promise<Set<string> | null> {
    const cached = this.cache.get(postId)
    if (cached) return Promise.resolve(cached)
    const inFlight = this.inFlight.get(postId)
    if (inFlight) return inFlight

    return new Promise<Set<string> | null>((resolve) => {
      const waiters = this.pending.get(postId)
      if (waiters) {
        waiters.push(resolve)
      } else {
        this.pending.set(postId, [resolve])
      }
      this.batchTimer ??= setTimeout(() => {
        this.batchTimer = null
        this.processBatch().catch((err) => logger.error(`Failed to process ${this.kind} validation batch:`, err))
      }, BATCH_DELAY_MS)
    })
  }

  private async processBatch(): Promise<void> {
    const batch = new Map(this.pending)
    this.pending.clear()

    await Promise.all(
      Array.from(batch.entries()).map(async ([postId, waiters]) => {
        const promise: Promise<Set<string> | null> = this.fetchRegistered(postId).catch((error) => {
          logger.error(`Error fetching ${this.kind}s for post ${postId}:`, error)
          return null
        })
        this.inFlight.set(postId, promise)
        try {
          const registered = await promise
          if (registered) this.cache.set(postId, registered)
          waiters.forEach((resolve) => resolve(registered))
        } finally {
          setTimeout(() => {
            if (this.inFlight.get(postId) === promise) this.inFlight.delete(postId)
          }, IN_FLIGHT_LINGER_MS)
        }
      })
    )
  }
}

export const hashtagValidation = new PostFieldValidator({
  kind: 'hashtag',
  extract: extractAllTags,
  // v4+: the post's single hashtag is written atomically with the post, so
  // there is no "registration failed" state and nothing to recover.
  isInline: hashtagsAreInline,
  fetchRegistered: async (postId) => {
    const documents = await hashtagService.getHashtagsForPost(postId)
    return new Set(documents.map((doc) => doc.hashtag))
  },
})

export const mentionValidation = new PostFieldValidator({
  kind: 'mention',
  extract: extractMentions,
  // Mention documents carry identity ids; content carries usernames, so the
  // registered set is resolved back to normalized usernames for comparison.
  fetchRegistered: async (postId) => {
    const documents = await mentionService.getMentionsForPost(postId)
    if (documents.length === 0) return new Set()
    const usernames = await dpnsService.resolveUsernamesBatch(documents.map((doc) => doc.mentionedUserId))
    const registered = new Set<string>()
    usernames.forEach((username) => {
      if (username) registered.add(normalizeDpnsUsername(username))
    })
    return registered
  },
})

export function postFieldValidator(kind: PostFieldKind): PostFieldValidator {
  return kind === 'hashtag' ? hashtagValidation : mentionValidation
}

/** Name of the window event a successful registration dispatches. */
export function registeredEventName(kind: PostFieldKind): string {
  return `${kind}-registered`
}

export interface FieldRegisteredDetail {
  postId: string
  value: string
}

export function dispatchFieldRegistered(kind: PostFieldKind, detail: FieldRegisteredDetail): void {
  postFieldValidator(kind).invalidate(detail.postId)
  window.dispatchEvent(new CustomEvent<FieldRegisteredDetail>(registeredEventName(kind), { detail }))
}
