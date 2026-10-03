import type { CapabilitiesDTO, PostDTO, TargetRef } from '@engine/api';
import { router } from 'expo-router';
import { memo, useMemo } from 'react';

import { queryKeys } from '~/data/keys';
import { usePostRemoved } from '~/data/optimistic';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useCapabilities, useProvisionalViewerId, useViewerId } from '~/data/session';
import { sendWrite } from '~/data/writes';
import { usePendingWriteStatus } from '~/features/compose/pending-posts';
import { tagMaxLength } from '~/features/compose/text';
import { usePostSafety } from '~/features/safety/use-post-safety';
import { showActionSheet, type SheetAction } from '~/ui/action-sheet';
import type { MenuItem } from '~/ui/ContextMenu';
import { confirmAlert } from '~/ui/Dialog';
import { lightImpact, mediumImpact } from '~/ui/haptics';
import { useMediaUrls } from '~/ui/media-url';
import {
  PostCard,
  type EngagementCountTab,
  type PostCardActions,
  type PostCardMenu,
  type PostCardProps,
} from '~/ui/post/PostCard';
import type { CardPoll, Loadable } from '~/ui/post/types';
import { toast } from '~/ui/toast';

import {
  copyText,
  openExternal,
  openHashtag,
  openPost,
  openUser,
  postWebUrl,
  sharePost,
} from './post-navigation';
import { readEngageStats } from './post-stats';
import { bookmarkWrite, deleteWrite, followWrite, likeWrite, repostWrite, targetOf } from './post-writes';

export interface PostItemProps
  extends Omit<PostCardProps, 'post' | 'actions' | 'menu' | 'viewerId' | 'canRepost' | 'canBookmark' | 'poll'> {
  post: PostDTO;
  /**
   * A post this device deleted: `hide` (default) leaves lists at once;
   * `stub` shows the "deleted" line in its place, for threads (replies
   * below it keep their parent), detail screens (which should pop when
   * their root is deleted: `usePostRemoved(id)`) and Bookmarks (PRD ENG-04).
   * A blocked author's post goes the same way: hidden, or its blocked stub.
   */
  removal?: 'hide' | 'stub';
  /**
   * The Bookmarks screen's "Remove bookmark" in the card's menu (PRD ENG-04,
   * UX_SPEC §4.24), called with the listed post; a blocked author's stub
   * keeps it as its only item.
   */
  onRemoveBookmark?: (post: PostDTO) => void;
}

/**
 * Plain values in closures throughout: React Compiler reads a closure's
 * property paths (`target.id`) while rendering, so `target!.id` on a maybe-
 * undefined value throws during render.
 */

/**
 * A v10 bare repost shows its target, attributed to the reposter (web
 * `BareRepostCard`). The target's counts and the viewer's marks on it come
 * from `engage.stats`: a quoted post arrives without them.
 */
function useShownPost(post: PostDTO): { post: PostDTO; marksPending: boolean; reloadMarks: (() => void) | null } {
  const target = post.bareRepost ? post.quoted : undefined;
  const targetId = target?.id ?? '';
  const targetKind = target?.kind ?? 'post';
  const { data: fresh, isError, refetch } = useEngineQuery(
    queryKeys.post.stats(targetId),
    async () => {
      const stats = await readEngageStats(targetId, targetKind);
      return stats ? { id: targetId, ...stats } : null;
    },
    { enabled: target !== undefined },
  );
  const shown = useMemo(() => {
    if (!target) return post;
    // Only what is known: `engage.stats` carries the marks, never the follow or block state.
    const viewer =
      fresh?.viewer || target.viewer ? ({ ...target.viewer, ...fresh?.viewer } as PostDTO['viewer']) : undefined;
    return {
      ...target,
      stats: fresh?.stats ?? target.stats,
      viewer,
      repostedBy: {
        id: post.author.id,
        username: post.author.username ?? undefined,
        displayName: post.author.displayName,
        others: post.repostedBy?.others,
      },
      repostTimestamp: post.createdAt,
    };
  }, [post, target, fresh]);
  // Until `engage.stats` answers, a bare repost's like, repost and bookmark state is unknown.
  return {
    post: shown,
    marksPending: target !== undefined && fresh === undefined,
    // A failed read is asked again on the next press, rather than blocking the controls for good.
    reloadMarks: isError ? () => refetch().catch(() => undefined) : null,
  };
}

/** The read-only poll a post shows (`posts.poll`), as the card renders it. */
function usePoll(post: PostDTO): Loadable<CardPoll> | undefined {
  const poll = post.poll;
  const pollId = poll?.id ?? '';
  const contractId = post.embed?.contractId;
  const { data, isError } = useEngineQuery(
    queryKeys.post.poll(pollId),
    (api) => api.posts.poll({ contractId, id: pollId }),
    { enabled: poll !== undefined },
  );
  return useMemo(() => {
    if (!poll) return undefined;
    if (isError || data === null) return 'error';
    if (!data) return 'loading';
    const options = data.options.map((o) => ({ label: o.text, votes: o.votes }));
    return {
      question: data.question,
      options,
      totalVotes: data.totalVotes ?? options.reduce((sum, o) => sum + o.votes, 0),
      endsAt: data.endsAt,
    };
  }, [poll, data, isError]);
}

/** The repost button's sheet (PRD ENG-02), by the viewer's slot. */
function repostSheet(
  post: PostDTO,
  capabilities: CapabilitiesDTO | null,
  run: { repost: () => void; undo: () => void; quote: () => void; deleteQuote: () => void },
): SheetAction[] {
  const viewer = post.viewer;
  const slotRules = capabilities?.repostsAreQuotes === true;
  const canQuote = !post.encrypted;
  const quote = canQuote ? [{ label: 'Quote', onPress: run.quote }] : [];
  // v10's one slot holds a quote with text (`reposted` too, as on web): it is deleted as a post, or visited.
  const ownQuote = slotRules && viewer?.ownQuoteBare === false ? viewer.ownQuoteId : null;
  if (ownQuote) {
    return [
      { label: 'Delete your quote', destructive: true, onPress: run.deleteQuote },
      { label: 'View your quote', onPress: () => openPost(ownQuote) },
    ];
  }
  if (viewer?.reposted) {
    // v10's one slot holds the repost: no quote beside it.
    return [{ label: 'Undo repost', onPress: run.undo }, ...(slotRules ? [] : quote)];
  }
  return [{ label: 'Repost', onPress: run.repost }, ...quote];
}

const REMOVE_BOOKMARK: MenuItem = { id: 'remove-bookmark', title: 'Remove bookmark', systemImage: 'bookmark.slash' };

/** The ⋯ and long-press menu (PRD ENG-08), in its order; a screen's own item (Bookmarks) after "Share…". */
function menuItems(post: PostDTO, own: boolean, followKnown: boolean, removeBookmark: boolean): MenuItem[] {
  const handle = post.author.username ? `@${post.author.username}` : post.author.displayName;
  const follows = post.viewer?.followsAuthor === true;
  const noun = post.kind === 'reply' ? 'reply' : 'post';
  const items: MenuItem[] = [];
  // A blocked author's post is its stub: nothing to follow, block or report.
  if (post.viewer?.authorBlocked) return removeBookmark ? [REMOVE_BOOKMARK] : items;
  if (!own && followKnown) {
    items.push({
      id: 'follow',
      title: `${follows ? 'Unfollow' : 'Follow'} ${handle}`,
      systemImage: follows ? 'person.badge.minus' : 'person.badge.plus',
    });
  }
  items.push(
    { id: 'engagements', title: 'View post engagements', systemImage: 'chart.bar' },
    { id: 'copy-link', title: 'Copy link', systemImage: 'link' },
    { id: 'share', title: 'Share…', systemImage: 'square.and.arrow.up' },
  );
  if (removeBookmark) items.push(REMOVE_BOOKMARK);
  if (own && !post.deleted) {
    items.push({ id: 'delete', title: `Delete ${noun}`, systemImage: 'trash', destructive: true });
  }
  if (!own) {
    items.push(
      { id: 'block', title: `Block ${handle}`, systemImage: 'nosign', destructive: true },
      { id: 'report', title: `Report ${noun}`, systemImage: 'flag' },
    );
  }
  return items;
}

/** The delete confirmation's body, by what a delete does on this contract (web DeleteConfirmationModal). */
function deleteMessage(noun: string, capabilities: CapabilitiesDTO | null): string {
  if (capabilities?.deletesAreTombstones) {
    return `This can't be undone. The text and media are erased; the ${noun} is hidden from feeds and shows as 'deleted by its author' in threads and quotes, and its likes and replies stay.`;
  }
  const base = `This action cannot be undone. The ${noun} will be permanently removed from the platform.`;
  return capabilities?.repostsAreQuotes ? `${base} Replies and quotes stay, and show that it was deleted.` : base;
}

const DELETED_TOAST = { post: 'Post deleted', reply: 'Reply deleted', quote: 'Quote deleted' } as const;

/** The native delete confirmation (UX_SPEC §2.13), then the optimistic delete (PRD ENG-06). */
async function confirmDelete(
  target: TargetRef,
  noun: keyof typeof DELETED_TOAST,
  capabilities: CapabilitiesDTO | null,
  quotedPostId?: string,
): Promise<void> {
  const kind = noun === 'reply' ? 'reply' : 'post';
  const confirmed = await confirmAlert({
    title: `Delete ${kind}?`,
    message: deleteMessage(kind, capabilities),
    confirmText: 'Delete',
    destructive: true,
  });
  if (confirmed) sendWrite(deleteWrite, { target, quotedPostId }, DELETED_TOAST[noun]);
}

/**
 * A post wired to the engine: the design system's `PostCard` with every
 * action (PRD ENG-01 – ENG-08). Likes, reposts, bookmarks and follows are
 * optimistic everywhere the post is cached; signed out, each opens the
 * sign-in sheet. Feed, thread, profile and bookmark lists all render this.
 * Pass card props (`variant`, `replyingTo`, ...) through.
 */
export const PostItem = memo(function PostItem({
  post: listed,
  removal = 'hide',
  onRemoveBookmark,
  ...cardProps
}: PostItemProps) {
  const { post: shownPost, marksPending, reloadMarks } = useShownPost(listed);
  const poll = usePoll(shownPost);
  const listedRemoved = usePostRemoved(listed.id);
  const shownRemoved = usePostRemoved(shownPost.id);
  const removed = listedRemoved || shownRemoved;
  const asStub = removed && removal === 'stub';
  const viewerId = useViewerId();
  // While the engine restores the session, the cached feed is the last account's: its own and followed
  // media stay ungated meanwhile (SAFE-07), and with nobody signed in last time everything is gated.
  const safetyViewerId = useProvisionalViewerId();
  // Blocks, the NSFW mode and the media gate (PRD G-6, SAFE-06, SAFE-07).
  const safety = usePostSafety(listed, shownPost, removal, safetyViewerId);
  const safePost = safety.post;
  const post = useMemo(() => (asStub ? { ...safePost, deleted: true } : safePost), [asStub, safePost]);
  // A post compose is still publishing: the optimistic card with its write status (PRD COMP-10).
  const pending = usePendingWriteStatus(listed.id);
  const capabilities = useCapabilities();
  const { external } = useMediaUrls();

  const own = viewerId !== null && viewerId === post.author.id;
  const detail = cardProps.variant === 'detail';
  // A bare repost's target comes without the viewer's follow of its author: offer no follow item then.
  const followKnown =
    viewerId === null || !listed.bareRepost || typeof listed.quoted?.viewer?.followsAuthor === 'boolean';

  const { actions, menu } = useMemo(() => {
    // A bare repost's marks are unknown until engage.stats answers: acting on a guess would send a duplicate.
    // Signed out, the sign-in sheet comes first either way.
    const known = (action: () => void) => () =>
      requireAuth(() => {
        if (!marksPending) {
          action();
          return;
        }
        reloadMarks?.();
        toast('Loading this post. Try again in a moment.');
      });

    const like = known(() => sendWrite(likeWrite, { post, like: !post.viewer?.liked }));

    const deleteQuote = () => {
      const quoteId = post.viewer?.ownQuoteId;
      if (!quoteId || !viewerId) {
        toast.error('Could not load your quote. Try again in a moment.');
        return;
      }
      const target: TargetRef = { id: quoteId, kind: 'post', ownerId: viewerId, rootPostId: null };
      confirmDelete(target, 'quote', capabilities, post.id).catch(() => undefined);
    };

    const repost = (on: boolean) => {
      mediumImpact();
      sendWrite(repostWrite, { post, repost: on, onQuoteHasText: deleteQuote }, on ? 'Reposted!' : 'Removed repost');
    };

    const quote = () => requireAuth(() => router.push({ pathname: '/compose', params: { quote: post.id } }));

    const bookmark = known(() => {
      const on = !post.viewer?.bookmarked;
      sendWrite(bookmarkWrite, { post, bookmark: on }, on ? 'Added to bookmarks' : 'Removed from bookmarks');
    });

    const follow = () =>
      requireAuth(() => {
        const on = post.viewer?.followsAuthor !== true;
        if (on) lightImpact();
        sendWrite(followWrite, { authorId: post.author.id, follow: on });
      });

    const openOnWeb = () => openExternal(postWebUrl(post));
    const openEngagements = (tab?: EngagementCountTab) =>
      router.push({ pathname: '/post/[id]/engagements', params: { id: post.id, kind: post.kind, ...(tab ? { tab } : {}) } });

    const menuActions: Record<string, () => void> = {
      follow,
      engagements: () => openEngagements(),
      'copy-link': () => copyText(postWebUrl(post), 'Link copied to clipboard'),
      share: () => sharePost(post),
      delete: () => {
        // A v10 quote holds the viewer's one slot on the post it quotes: deleting it frees that.
        const quotedPostId = capabilities?.repostsAreQuotes ? post.quotedPostId : undefined;
        confirmDelete(targetOf(post), post.kind, capabilities, quotedPostId).catch(() => undefined);
      },
      block: () => requireAuth(() => router.push({ pathname: '/block/[userId]', params: { userId: post.author.id } })),
      report: () => {
        const openReport = () =>
          router.push({ pathname: '/report/[postId]', params: { postId: post.id, kind: post.kind } });
        // Where the contract takes no reports, the sheet offers an email, which needs no account (PRD SAFE-05).
        if (capabilities?.reports === false) openReport();
        else requireAuth(openReport);
      },
      ...(onRemoveBookmark ? { 'remove-bookmark': () => onRemoveBookmark(listed) } : {}),
    };
    const onSelect = (id: string) => menuActions[id]?.();

    const reposterId = post.repostedBy?.id;
    const quoted = post.quoted;
    const actions: PostCardActions = {
      // The detail card is the open post: tapping it again would push it twice.
      onPress: detail ? undefined : () => openPost(post),
      onCountPress: openEngagements,
      onAuthorPress: () => openUser(post.author.id),
      onReposterPress: reposterId ? () => openUser(reposterId) : undefined,
      onCopyId: () => copyText(post.author.id, 'Identity ID copied'),
      onReply: () => requireAuth(() => router.push({ pathname: '/compose', params: { replyTo: post.id } })),
      onRepost: known(() =>
        showActionSheet({
          actions: repostSheet(post, capabilities, {
            repost: () => repost(true),
            undo: () => repost(false),
            quote,
            deleteQuote,
          }),
        }),
      ),
      onLike: like,
      onBookmark: bookmark,
      onShare: () => sharePost(post),
      onQuotePress: quoted ? () => openPost(quoted) : undefined,
      onMediaPress: (index) => router.push({ pathname: '/media', params: { postId: post.id, index: String(index) } }),
      onLinkPress: (url) => openExternal(external(url)),
      onLinkPreviewPress: (url) => openExternal(external(url)),
      onMentionPress: openUser,
      onHashtagPress: openHashtag,
      onCashtagPress: openHashtag,
      onVotePress: openOnWeb,
      onOpenPrivate: openOnWeb,
    };
    const items = menuItems(post, own, followKnown, onRemoveBookmark !== undefined);
    const menu: PostCardMenu | undefined = items.length > 0 ? { items, onSelect } : undefined;
    return { actions, menu };
  }, [post, own, followKnown, marksPending, reloadMarks, viewerId, capabilities, external, detail, onRemoveBookmark, listed]);

  if ((removed && !asStub) || safety.hidden) return null;

  if (pending) {
    return (
      <PostCard
        {...safety.gates}
        {...cardProps}
        variant="optimistic"
        post={post}
        viewerId={viewerId ?? undefined}
        writeStatus={pending}
        actions={{ onAuthorPress: actions.onAuthorPress }}
      />
    );
  }

  return (
    <PostCard
      {...safety.gates}
      {...cardProps}
      post={post}
      viewerId={viewerId ?? undefined}
      canRepost={capabilities?.repostable[post.kind] ?? true}
      canBookmark={capabilities?.bookmarkable[post.kind] ?? true}
      // A tag opens the page it was indexed under: its first 61 characters on dev, 63 elsewhere.
      tagMaxLength={tagMaxLength(capabilities?.hashtagsInline === true)}
      poll={poll}
      actions={actions}
      menu={menu}
    />
  );
});
