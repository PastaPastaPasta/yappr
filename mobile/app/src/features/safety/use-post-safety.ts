import type { PostDTO, ViewerStateDTO } from '@engine/api';
import { useCallback, useMemo, useState } from 'react';

import { useAuthorBlocked } from './block-state';
import { useContentSettings, type NsfwMode } from './content-settings';

/** The PostCard props the content gates decide (PRD SAFE-06, SAFE-07). */
export interface PostGateProps {
  nsfwGated: boolean;
  quoteNsfwGated?: boolean;
  mediaGated: boolean;
  quoteMediaGated: boolean;
  onRevealMedia: () => void;
}

export interface PostSafety {
  /** Render nothing: a browsing list drops the card (G-6, SAFE-06 Hide). */
  hidden: boolean;
  /** The shown post with this device's block decisions on it and its quote (the card shows the blocked stubs). */
  post: PostDTO;
  gates: PostGateProps;
}

const flagged = (post: PostDTO | undefined, mode: NsfwMode) =>
  post !== undefined && post.sensitive && !post.deleted && mode !== 'show';

/** `post` with `viewer.authorBlocked` set to `blocked`, the same object when it already says so. */
function withAuthorBlocked(post: PostDTO, blocked: boolean): PostDTO {
  if ((post.viewer?.authorBlocked === true) === blocked) return post;
  return { ...post, viewer: { ...post.viewer, authorBlocked: blocked } as ViewerStateDTO };
}

/**
 * What the viewer's safety choices do to one post card:
 *
 * - **Blocks (G-6):** an author blocked (here or, per the engine, anywhere)
 *   leaves browsing lists (`removal: 'hide'`); in threads (`stub`) the card
 *   collapses to "Reply from an account you blocked". A quote of a blocked
 *   author shows "Post from an account you blocked". A bare repost by a
 *   blocked account goes too.
 * - **NSFW (SAFE-06):** Warn first and Hide cover a flagged post (and a
 *   flagged quote); Always show doesn't. The engine leaves Hide's posts out
 *   of browsing lists, except a bare repost of one, which is judged by its
 *   target here, as web does. The viewer's own posts are never hidden.
 * - **Media (SAFE-07):** with the gate on, media from authors the viewer
 *   doesn't follow (everyone, signed out) waits behind "Show", which
 *   reveals all of the card's media. Own media is never gated, and a follow
 *   lifts the gate on every card of that author at once.
 * - **Removed targets:** a bare repost whose target moderators removed
 *   leaves lists, except for its reposter, who sees the stub to undo it.
 */
export function usePostSafety(
  listed: PostDTO,
  shown: PostDTO,
  removal: 'hide' | 'stub',
  viewerId: string | null,
): PostSafety {
  const { nsfwMode, gateMedia } = useContentSettings();
  const authorBlocked = useAuthorBlocked(shown.author.id, shown.viewer?.authorBlocked);
  const reposterBlocked = useAuthorBlocked(listed.bareRepost ? listed.author.id : undefined, listed.viewer?.authorBlocked);
  const quoted = shown.quoted;
  const quoteBlocked = useAuthorBlocked(quoted?.author.id, quoted?.viewer?.authorBlocked);
  // Per card and post (a recycled cell starts gated again).
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const shownId = shown.id;
  const onRevealMedia = useCallback(() => setRevealedId(shownId), [shownId]);

  const post = useMemo(() => {
    const next = withAuthorBlocked(shown, authorBlocked);
    if (!next.quoted) return next;
    const nextQuote = withAuthorBlocked(next.quoted, quoteBlocked);
    return nextQuote === next.quoted ? next : { ...next, quoted: nextQuote };
  }, [shown, authorBlocked, quoteBlocked]);

  const own = viewerId !== null && viewerId === shown.author.id;
  const hiddenNsfwRepost = nsfwMode === 'hide' && listed.bareRepost && flagged(shown, nsfwMode) && !own;
  const removedTarget =
    listed.bareRepost && !listed.quoted && listed.quotedRemoved && viewerId !== listed.author.id;
  const hidden = removal === 'hide' && (authorBlocked || reposterBlocked || hiddenNsfwRepost || removedTarget);

  const revealed = revealedId === shownId;
  const gatedFor = (author: string, followed: boolean | undefined) =>
    gateMedia && !revealed && (viewerId === null || (author !== viewerId && followed !== true));
  const quoteAuthor = quoted?.author.id;
  const gates: PostGateProps = {
    nsfwGated: flagged(shown, nsfwMode),
    quoteNsfwGated: quoted ? flagged(quoted, nsfwMode) : undefined,
    mediaGated: shown.media.length > 0 && gatedFor(shown.author.id, shown.viewer?.followsAuthor),
    quoteMediaGated: quoteAuthor !== undefined && gatedFor(quoteAuthor, quoted?.viewer?.followsAuthor),
    onRevealMedia,
  };
  return { hidden, post, gates };
}
