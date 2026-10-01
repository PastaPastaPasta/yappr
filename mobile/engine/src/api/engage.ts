import { TtlMap } from '@/lib/caches/ttl-map'
import { canBookmark, canRepost, repostsAreQuotes, type KindedTarget } from '@/lib/contract-topology'
import { isDuplicateUniqueIndexError } from '@/lib/error-utils'
import type { OwnQuote } from '@/lib/feed/quote-reposts'
import { resolveQuoteReference } from '@/lib/feed/resolve-quoted-posts'
import { bookmarkService } from '@/lib/services/bookmark-service'
import { likeService } from '@/lib/services/like-service'
import { postService } from '@/lib/services/post-service'
import { repostService } from '@/lib/services/repost-service'
import { RpcError } from '../protocol/envelope'
import { assertAtMost, enrichToDTOs, notSupported, requireViewer, viewerId, withLoadingAuthor } from '../dto/hydrate'
import { pageOfList } from '../dto/paging'
import {
  assertTarget, probeRelation, proveDocuments, settleTarget, signer, socialDoc, targetStub, ticketTarget,
} from '../writes/handler-kit'
import { fromBoolean, wasConfirmed } from '../writes/lib-results'
import type { TicketStore, WriteResult } from '../writes/tickets'
import type { TargetRef, WriteOp, WriteTicket } from '../writes/types'
import type { EngageStatsDTO, Page, PostDTO } from './dto'

/** `app/bookmarks/page.tsx` reads every bookmark at once; the engine pages them. */
const BOOKMARKS_PAGE = 20

const bookmarkLists = new TtlMap<string, string[]>(60_000)

/**
 * Engagement reads (`hooks/use-post-engagement.ts`). The writes (like,
 * repost, bookmark) and `bookmarks` are in {@link createEngageWrites}.
 */
export const engage = {
  /**
   * Fresh counts for up to 100 posts or replies (`getBatchPostStats`) and,
   * signed in, the viewer's marks (`getBatchUserInteractions`). Pass a
   * reply's `rootPostId` where known: v10 counts a reply's replies under its root.
   *
   * lib's batch stats read reports a failure as zero counts, not an error, so
   * these are advisory: never let them lower counts already on screen to 0.
   */
  async stats(targets: KindedTarget[]): Promise<Record<string, EngageStatsDTO>> {
    assertAtMost(targets, 100, 'targets')
    const signedIn = viewerId() !== null
    const [stats, marks] = await Promise.all([
      postService.getBatchPostStats(targets),
      signedIn ? postService.getBatchUserInteractions(targets) : undefined,
    ])
    return Object.fromEntries(targets.map(({ id }) => {
      const counts = stats.get(id)
      const mark = marks?.get(id)
      const entry: EngageStatsDTO = {
        stats: { likes: counts?.likes ?? 0, reposts: counts?.reposts ?? 0, replies: counts?.replies ?? 0, quotes: counts?.quotes ?? 0 },
      }
      if (signedIn) {
        entry.viewer = { liked: mark?.liked === true, reposted: mark?.reposted === true, bookmarked: mark?.bookmarked === true, ownQuoteId: mark?.ownQuote?.id ?? null }
      }
      return [id, entry]
    }))
  },
}

interface TargetArgs {
  target: TargetRef
}

interface UnrepostArgs extends TargetArgs {
  /** v10: the viewer's bare repost to delete; `null` when there was none (nothing to undo). */
  quoteId: string | null
}

/** v10: the viewer's quote or bare repost of `target` (`getOwnQuotes`; none when unreadable, as on web). */
async function ownQuote(viewer: string, target: TargetRef): Promise<OwnQuote | null> {
  return (await postService.getOwnQuotes(viewer, [target.id], target.kind)).get(target.id) ?? null
}

/**
 * v10: a bare repost is a content-less quote post, one quote or repost per
 * author and target. A 40105 means the slot is taken: by the viewer's own
 * earlier repost (a double tap, a lost ack), which is the repost asked for,
 * or by a quote with text, which stays a `DUPLICATE` failure
 * (`use-post-engagement.ts` `toggleRepost`).
 */
async function createBareRepost(viewer: string, target: TargetRef): Promise<WriteResult> {
  try {
    const created = await postService.createPost(viewer, '', resolveQuoteReference(targetStub(target)).fields)
    return { state: wasConfirmed(created) ? 'confirmed' : 'unconfirmed', documents: [socialDoc('post', created.id, 'create')] }
  } catch (error) {
    if (!isDuplicateUniqueIndexError(error)) throw error
    const existing = await ownQuote(viewer, target)
    if (existing?.bare) return { state: 'confirmed', documents: [socialDoc('post', existing.id, 'create', true)] }
    throw error
  }
}

const isReposted = async (viewer: string, target: TargetRef) => repostsAreQuotes()
  ? (await ownQuote(viewer, target))?.bare === true
  : repostService.isReposted(target.id, viewer)

/**
 * The engagement writes (`hooks/use-post-engagement.ts`), one ticket each.
 * Like, repost and bookmark settle a target this session created unconfirmed
 * first, as web does; the undos need no gate (the document already exists).
 */
export function createEngageWrites(tickets: TicketStore) {
  const relation = (present: (viewer: string, target: TargetRef) => Promise<boolean>, expected: boolean) =>
    (ticket: WriteTicket) => probeRelation(() => present(ticket.identityId ?? '', ticketTarget(ticket)), expected)

  const liked = (viewer: string, target: TargetRef) => likeService.isLiked(target.id, viewer, target.kind)
  const bookmarked = async (viewer: string, target: TargetRef) =>
    (await bookmarkService.getBookmark(target.id, viewer, { throwOnError: true })) !== null

  tickets.register<TargetArgs>('like', {
    persistArgs: true,
    async run({ target }, ctx) {
      await settleTarget(ctx, target.id)
      // The target's author is agreement-bound on v9/v10 likes; its tag lib reads itself.
      return fromBoolean(await likeService.likePost(target.id, signer(ctx), target.ownerId, target.kind, { author: target.ownerId }))
    },
    probe: relation(liked, true),
  })
  tickets.register<TargetArgs>('unlike', {
    persistArgs: true,
    async run({ target }, ctx) {
      return fromBoolean(await likeService.unlikePost(target.id, signer(ctx), target.kind, { author: target.ownerId }))
    },
    probe: relation(liked, false),
  })
  tickets.register<TargetArgs>('repost', {
    persistArgs: true,
    async run({ target }, ctx) {
      await settleTarget(ctx, target.id)
      const viewer = signer(ctx)
      return repostsAreQuotes()
        ? createBareRepost(viewer, target)
        : fromBoolean(await repostService.repostPost(target.id, viewer, target.ownerId))
    },
    probe: relation(isReposted, true),
  })
  tickets.register<UnrepostArgs>('unrepost', {
    persistArgs: true,
    async run({ target, quoteId }, ctx) {
      const viewer = signer(ctx)
      if (!repostsAreQuotes()) return fromBoolean(await repostService.removeRepost(target.id, viewer))
      if (!quoteId) return { state: 'confirmed' }
      return fromBoolean(await postService.deletePost(quoteId, viewer))
    },
    // v10 names the deleted quote post; off v10 the repost document is read back.
    probe: (ticket) => ticket.documents.length > 0
      ? proveDocuments(ticket.documents)
      : relation(isReposted, false)(ticket),
  })
  tickets.register<TargetArgs>('bookmark', {
    persistArgs: true,
    async run({ target }, ctx) {
      await settleTarget(ctx, target.id)
      return fromBoolean(await bookmarkService.bookmarkPost(target.id, signer(ctx)))
    },
    probe: relation(bookmarked, true),
  })
  tickets.register<TargetArgs>('unbookmark', {
    persistArgs: true,
    async run({ target }, ctx) {
      return fromBoolean(await bookmarkService.removeBookmark(target.id, signer(ctx)))
    },
    probe: relation(bookmarked, false),
  })

  function submit(op: WriteOp, target: TargetRef, what: string, gate?: (kind: TargetRef['kind']) => boolean): WriteTicket {
    assertTarget(target)
    requireViewer(what)
    if (gate && !gate(target.kind)) throw notSupported(`${what} a ${target.kind}`)
    return tickets.submit<TargetArgs>({ op, args: { target }, target })
  }

  return {
    like: async (target: TargetRef): Promise<WriteTicket> => submit('like', target, 'Liking'),
    unlike: async (target: TargetRef): Promise<WriteTicket> => submit('unlike', target, 'Unliking'),
    /** Off v10 a `repost` document; on v10 a bare quote post (`DUPLICATE` when a quote with text holds the slot). */
    repost: async (target: TargetRef): Promise<WriteTicket> => submit('repost', target, 'Reposting', canRepost),

    /**
     * Undo the viewer's repost. On v10 that deletes their quote post, so a
     * quote WITH text is never deleted here: the call rejects with
     * `QUOTE_HAS_TEXT`, and the UI confirms and deletes it with
     * `posts.delete` (its id is `PostDTO.viewer.ownQuoteId`). No quote found
     * (none, or unreadable, as on web) is a confirmed no-op.
     */
    async unrepost(target: TargetRef): Promise<WriteTicket> {
      assertTarget(target)
      const viewer = requireViewer('Undoing a repost')
      if (!canRepost(target.kind)) throw notSupported(`Reposting a ${target.kind}`)
      if (!repostsAreQuotes()) return tickets.submit<UnrepostArgs>({ op: 'unrepost', args: { target, quoteId: null }, target })
      const quote = await ownQuote(viewer, target)
      if (quote && !quote.bare) throw new RpcError('Your quote of this has text: delete it as a post', 'QUOTE_HAS_TEXT')
      return tickets.submit<UnrepostArgs>({
        op: 'unrepost',
        args: { target, quoteId: quote?.id ?? null },
        target,
        documents: quote ? [socialDoc('post', quote.id, 'delete')] : [],
      })
    },

    bookmark: async (target: TargetRef): Promise<WriteTicket> => submit('bookmark', target, 'Bookmarking', canBookmark),
    unbookmark: async (target: TargetRef): Promise<WriteTicket> => submit('unbookmark', target, 'Removing a bookmark', canBookmark),

    /**
     * The viewer's bookmarks, newest first (`app/bookmarks/page.tsx`): every
     * bookmark once, then 20 posts a page, enriched. Bookmarked posts that
     * are gone are skipped. lib reports a failed bookmark read as none.
     */
    async bookmarks(cursor?: string | null): Promise<Page<PostDTO>> {
      const viewer = requireViewer('Bookmarks')
      return pageOfList({
        kind: 'bookmarks',
        key: viewer,
        cursor,
        size: BOOKMARKS_PAGE,
        cache: bookmarkLists,
        load: async () => (await bookmarkService.getUserBookmarks(viewer)).map(bookmark => bookmark.postId).filter(Boolean),
        hydrate: async (ids) => {
          const { posts, preloaded } = await postService.getPostsByIdsForDisplay(ids)
          const byId = new Map(posts.map(post => [post.id, post]))
          return enrichToDTOs(ids.flatMap(id => byId.get(id) ?? []).map(withLoadingAuthor), preloaded)
        },
      })
    },
  }
}
