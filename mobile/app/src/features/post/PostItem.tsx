import type { CapabilitiesDTO, PostDTO, TargetRef, ViewerStateDTO } from '@engine/api';
import { router } from 'expo-router';
import { memo, useMemo, useState } from 'react';

import { queryKeys } from '~/data/keys';
import { usePostRemoved } from '~/data/optimistic';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useCapabilities, useViewerId } from '~/data/session';
import { submitWrite } from '~/data/writes';
import { showActionSheet, type SheetAction } from '~/ui/action-sheet';
import type { MenuItem } from '~/ui/ContextMenu';
import { ConfirmDialog } from '~/ui/Dialog';
import { lightImpact, mediumImpact } from '~/ui/haptics';
import { useMediaUrls } from '~/ui/media-url';
import { PostCard, type PostCardActions, type PostCardMenu, type PostCardProps } from '~/ui/post/PostCard';
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
import { bookmarkWrite, deleteWrite, followWrite, likeWrite, repostWrite, targetOf } from './post-writes';

export interface PostItemProps
  extends Omit<PostCardProps, 'post' | 'actions' | 'menu' | 'viewerId' | 'canRepost' | 'canBookmark' | 'poll'> {
  post: PostDTO;
}

/** A pending delete confirmation: the viewer's post or reply, or their v10 quote of this post. */
interface PendingDelete {
  target: TargetRef;
  noun: 'post' | 'reply' | 'quote';
  /** Set for a quote: the post whose slot it frees. */
  quotedPostId?: string;
}

/**
 * A v10 bare repost shows its target, attributed to the reposter (web
 * `BareRepostCard`). The target's counts and the viewer's marks on it come
 * from `engage.stats`: a quoted post arrives without them.
 */
function useShownPost(post: PostDTO): PostDTO {
  const target = post.bareRepost ? post.quoted : undefined;
  const { data: fresh } = useEngineQuery(
    queryKeys.post.stats(target?.id ?? ''),
    async (api) => {
      const id = target!.id;
      const stats = (await api.engage.stats([{ id, kind: target!.kind }]))[id];
      return stats ? { id, ...stats } : null;
    },
    { enabled: target !== undefined },
  );
  return useMemo(() => {
    if (!target) return post;
    const viewer: ViewerStateDTO | undefined =
      fresh?.viewer || target.viewer
        ? {
            liked: false,
            reposted: false,
            bookmarked: false,
            ownQuoteId: null,
            authorBlocked: false,
            followsAuthor: false,
            ...target.viewer,
            ...fresh?.viewer,
          }
        : undefined;
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
}

/** The read-only poll a post shows (`posts.poll`), as the card renders it. */
function usePoll(post: PostDTO): Loadable<CardPoll> | undefined {
  const poll = post.poll;
  const { data, isError } = useEngineQuery(
    queryKeys.post.poll(poll?.id ?? ''),
    (api) => api.posts.poll({ contractId: post.embed?.contractId, id: poll!.id }),
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
  if (viewer?.reposted) {
    // v10's one slot holds the repost: no quote beside it.
    return [{ label: 'Undo repost', onPress: run.undo }, ...(slotRules ? [] : quote)];
  }
  const ownQuote = slotRules ? viewer?.ownQuoteId : null;
  if (ownQuote) {
    return [
      { label: 'Delete your quote', destructive: true, onPress: run.deleteQuote },
      { label: 'View your quote', onPress: () => openPost(ownQuote) },
    ];
  }
  return [{ label: 'Repost', onPress: run.repost }, ...quote];
}

/** The ⋯ and long-press menu (PRD ENG-08), in its order. */
function menuItems(post: PostDTO, own: boolean): MenuItem[] {
  const handle = post.author.username ? `@${post.author.username}` : post.author.displayName;
  const follows = post.viewer?.followsAuthor === true;
  const noun = post.kind === 'reply' ? 'reply' : 'post';
  const items: MenuItem[] = [];
  if (!own) {
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

/**
 * A post wired to the engine: the design system's `PostCard` with every
 * action (PRD ENG-01 – ENG-08). Likes, reposts, bookmarks and follows are
 * optimistic everywhere the post is cached; signed out, each opens the
 * sign-in sheet. Feed, thread, profile and bookmark lists all render this.
 * Pass card props (`variant`, `replyingTo`, ...) through.
 */
export const PostItem = memo(function PostItem({ post: listed, ...cardProps }: PostItemProps) {
  const post = useShownPost(listed);
  const poll = usePoll(post);
  const removed = usePostRemoved(listed.id);
  const shownRemoved = usePostRemoved(post.id);
  const viewerId = useViewerId();
  const capabilities = useCapabilities();
  const { external } = useMediaUrls();
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const own = viewerId !== null && viewerId === post.author.id;

  const { actions, menu } = useMemo(() => {
    const like = () =>
      requireAuth(() => {
        submitWrite(likeWrite, { post, like: !post.viewer?.liked }).catch(() => undefined);
      });

    const deleteQuote = () => {
      const quoteId = post.viewer?.ownQuoteId;
      if (!quoteId || !viewerId) {
        toast.error('Could not load your quote. Try again in a moment.');
        return;
      }
      setPendingDelete({
        target: { id: quoteId, kind: 'post', ownerId: viewerId, rootPostId: null },
        noun: 'quote',
        quotedPostId: post.id,
      });
    };

    const repost = (on: boolean) => {
      mediumImpact();
      submitWrite(repostWrite, { post, repost: on, onQuoteHasText: deleteQuote })
        .then((ticket) => {
          if (ticket) toast.success(on ? 'Reposted!' : 'Removed repost');
        })
        .catch(() => undefined);
    };

    const quote = () => requireAuth(() => router.push({ pathname: '/compose', params: { quote: post.id } }));

    const bookmark = () =>
      requireAuth(() => {
        const on = !post.viewer?.bookmarked;
        submitWrite(bookmarkWrite, { post, bookmark: on })
          .then((ticket) => {
            if (ticket) toast.success(on ? 'Added to bookmarks' : 'Removed from bookmarks');
          })
          .catch(() => undefined);
      });

    const follow = () =>
      requireAuth(() => {
        const on = post.viewer?.followsAuthor !== true;
        if (on) lightImpact();
        submitWrite(followWrite, { authorId: post.author.id, follow: on }).catch(() => undefined);
      });

    const onSelect = (id: string) => {
      switch (id) {
        case 'follow':
          return follow();
        case 'engagements':
          return router.push({ pathname: '/post/[id]/engagements', params: { id: post.id, kind: post.kind } });
        case 'copy-link':
          return copyText(postWebUrl(post.id), 'Link copied to clipboard');
        case 'share':
          return sharePost(post);
        case 'delete':
          return setPendingDelete({ target: targetOf(post), noun: post.kind });
        case 'block':
          return requireAuth(() => router.push({ pathname: '/block/[userId]', params: { userId: post.author.id } }));
        case 'report':
          return requireAuth(() =>
            router.push({ pathname: '/report/[postId]', params: { postId: post.id, kind: post.kind } }),
          );
      }
    };

    const actions: PostCardActions = {
      onPress: () => openPost(post),
      onAuthorPress: () => openUser(post.author.id),
      onReposterPress: post.repostedBy ? () => openUser(post.repostedBy!.id) : undefined,
      onCopyId: () => copyText(post.author.id, 'Identity ID copied'),
      onReply: () => requireAuth(() => router.push({ pathname: '/compose', params: { replyTo: post.id } })),
      onRepost: () =>
        requireAuth(() =>
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
      onQuotePress: post.quoted ? () => openPost(post.quoted!) : undefined,
      onMediaPress: (index) => router.push({ pathname: '/media', params: { postId: post.id, index: String(index) } }),
      onLinkPress: (url) => openExternal(external(url)),
      onLinkPreviewPress: (url) => openExternal(external(url)),
      onMentionPress: openUser,
      onHashtagPress: openHashtag,
      onCashtagPress: openHashtag,
      onVotePress: () => openExternal(postWebUrl(post.id)),
      onOpenPrivate: () => openExternal(postWebUrl(post.id)),
    };
    const menu: PostCardMenu = { items: menuItems(post, own), onSelect };
    return { actions, menu };
  }, [post, own, viewerId, capabilities, external]);

  if (removed || shownRemoved) return null;

  const confirmDelete = () => {
    const pending = pendingDelete;
    setPendingDelete(null);
    if (!pending) return;
    submitWrite(deleteWrite, { target: pending.target, quotedPostId: pending.quotedPostId })
      .then((ticket) => {
        if (ticket) toast.success(DELETED_TOAST[pending.noun]);
      })
      .catch(() => undefined);
  };
  const deleteNoun = pendingDelete?.noun === 'reply' ? 'reply' : 'post';

  return (
    <>
      <PostCard
        {...cardProps}
        post={post}
        viewerId={viewerId ?? undefined}
        canRepost={capabilities?.repostable[post.kind] ?? true}
        canBookmark={capabilities?.bookmarkable[post.kind] ?? true}
        poll={poll}
        actions={actions}
        menu={menu}
      />
      {pendingDelete ? (
        <ConfirmDialog
          isOpen
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
          title={`Delete ${deleteNoun}?`}
          message={deleteMessage(deleteNoun, capabilities)}
          confirmText="Delete"
        />
      ) : null}
    </>
  );
});
