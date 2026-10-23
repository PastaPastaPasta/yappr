import type { BlogCommentDTO, BlogPostDTO, BlogReportTargetDTO } from '@engine/api';
import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, Pressable, Text as RNText, TextInput, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useSessionStore, useViewerId } from '~/data/session';
import { runWrite, useWrite } from '~/data/writes';
import { viewerAuthor } from '~/features/compose/pending-posts';
import { openUser } from '~/features/post/post-navigation';
import { Avatar } from '~/ui/Avatar';
import { confirmAlert } from '~/ui/Dialog';
import { handleOf } from '~/ui/handle';
import { Spinner } from '~/ui/Spinner';
import { MIN_TARGET } from '~/ui/tokens';
import { useRelativeTime } from '~/ui/use-relative-time';

import { commentWrite, deleteCommentWrite, isLocalComment, isPendingComment, rereadCommentsLater } from './blog-writes';
import { onColor, type BlogPalette } from './blog-theme';

/** No comments read yet: one array, so what lists them is not rebuilt for it. */
const NONE: BlogCommentDTO[] = [];

export const CommentRow = memo(function CommentRow({ comment, palette, own, canReport, onReport, onDelete }: {
  comment: BlogCommentDTO;
  palette: BlogPalette;
  own: boolean;
  canReport: boolean;
  onReport: (comment: BlogCommentDTO) => void;
  onDelete: (comment: BlogCommentDTO) => void;
}) {
  const when = useRelativeTime(comment.createdAt);
  const name = comment.author?.displayName ?? 'Someone';
  const handle = comment.author ? handleOf(comment.author) : null;
  const pending = isPendingComment(comment);
  const local = isLocalComment(comment);
  return (
    <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 12, borderTopWidth: 1, borderColor: palette.border, opacity: pending ? 0.6 : 1 }} testID={`blog-comment-${comment.id}`}>
      <Avatar avatar={comment.author?.avatar} identityId={comment.ownerId} size="sm" name={name} onPress={() => openUser(comment.ownerId)} />
      <View style={{ flex: 1, gap: 4 }}>
        <RNText style={{ color: palette.muted, fontSize: 13 }} numberOfLines={1}>
          <RNText style={{ color: palette.heading, fontWeight: '600' }}>{name}</RNText>
          {handle && handle !== name ? ` ${handle}` : ''} · {when}
        </RNText>
        <RNText selectable style={{ color: palette.text, fontSize: 15, lineHeight: 21 }}>{comment.content}</RNText>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          {pending ? (
            <RNText style={{ color: palette.muted, fontSize: 13, minHeight: MIN_TARGET, textAlignVertical: 'center', paddingTop: 12 }}>Posting…</RNText>
          ) : local ? null : own ? (
            <Pressable onPress={() => onDelete(comment)} accessibilityRole="button" accessibilityLabel="Delete your comment" hitSlop={12} style={{ minHeight: MIN_TARGET, justifyContent: 'center' }} testID={`blog-comment-delete-${comment.id}`}>
              <RNText style={{ color: palette.muted, fontSize: 13 }}>Delete</RNText>
            </Pressable>
          ) : canReport ? (
            <Pressable onPress={() => onReport(comment)} accessibilityRole="button" accessibilityLabel="Report this comment" hitSlop={12} style={{ minHeight: MIN_TARGET, justifyContent: 'center' }} testID={`blog-comment-report-${comment.id}`}>
              <RNText style={{ color: palette.muted, fontSize: 13 }}>Report</RNText>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
});

/**
 * A post's comments (web `blog-comments.tsx`): read, write, delete your own,
 * report others'. The post screen calls this and lists the result, one row for
 * the header and one per comment (a post can have a hundred), so the draft and
 * the send state live here, in the screen, and survive the header row scrolling
 * out of the list.
 */
export function useBlogComments({ post, maxLength, canReport, onReport, onReveal, actionsRef }: {
  post: BlogPostDTO;
  maxLength: number;
  canReport: boolean;
  onReport: (target: BlogReportTargetDTO) => void;
  /** Scroll the screen down by this much, to bring the Post comment button up from under the keyboard. */
  onReveal?: (dy: number) => void;
  /** The composer's button row (`CommentsHeader`'s `actionsRef`), measured to bring it above the keyboard. */
  actionsRef: RefObject<View | null>;
}) {
  const viewerId = useViewerId();
  const username = useSessionStore((state) => state.session?.username ?? null);
  const [typed, setTyped] = useState('');
  /** What the last tap sent, until the writer types again: given back if it fails. */
  const [sent, setSent] = useState<string | null>(null);
  const send = useWrite(commentWrite);
  const query = useEngineQuery(queryKeys.blog.comments(post.id), (api) => api.blogs.comments(post.id), {
    enabled: post.commentsEnabled,
  });
  const shown = query.data ?? NONE;
  // From the tap, before the engine answers with a ticket, to the ticket settling: one comment at a time.
  const [starting, setStarting] = useState(false);
  const inFlight = useRef(false);
  const sending = starting || send.status === 'pending';
  // A comment that failed after it went out (or is stuck where it can be retried) gives its words back.
  const ticket = send.ticket;
  const lost =
    sent !== null &&
    ticket !== null &&
    ((send.status === 'failed' && ticket.error?.outcome !== 'unknown') || (send.status === 'unconfirmed' && ticket.retryable));
  const text = typed || (lost ? sent : '');
  // A failure that may still have landed undoes nothing and says nothing more: read the comments again later.
  const failedUnknown = send.status === 'failed' && ticket?.error?.outcome === 'unknown' ? ticket.id : null;
  useEffect(() => {
    if (failedUnknown) rereadCommentsLater(post.id);
  }, [failedUnknown, post.id]);
  const setText = (value: string) => {
    setTyped(value);
    setSent(null);
  };

  // The Post comment button sits below the field, where iOS doesn't scroll to: bring it up above the keyboard.
  const focused = useRef(false);
  const keyboardTop = useRef<number | null>(null);
  const reveal = () => {
    const top = keyboardTop.current;
    if (!focused.current || top === null || !onReveal) return;
    actionsRef.current?.measureInWindow((_x, y, _width, height) => {
      const overlap = y + height + 12 - top;
      if (overlap > 0) onReveal(overlap);
    });
  };
  const revealLatest = useRef(reveal);
  useEffect(() => {
    revealLatest.current = reveal;
  });
  useEffect(() => {
    const didShow = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      revealLatest.current();
    });
    const didHide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardTop.current = null;
    });
    return () => {
      didShow.remove();
      didHide.remove();
    };
  }, []);

  const submit = () =>
    requireAuth(() => {
      const content = text.trim();
      // A ref, not state: a second tap in the same frame still sees the first.
      if (!content || !viewerId || inFlight.current || send.status === 'pending') return;
      // The same words from the same writer already on their way are not sent twice.
      if (shown.some((comment) => isPendingComment(comment) && comment.ownerId === viewerId && comment.content === content)) {
        setText('');
        return;
      }
      inFlight.current = true;
      setStarting(true);
      // Sent: the field clears and the comment shows in the list at once (`commentWrite` is optimistic).
      setTyped('');
      setSent(content);
      const restore = () => setTyped((current) => current || content);
      send
        .send({ postId: post.id, postOwnerId: post.ownerId, content, author: viewerAuthor(viewerId, username), localId: `${Date.now()}` })
        .then((result) => {
          // Refused before it went out: nothing was sent, so the words come back to fix or send again.
          if (result.status === 'refused') restore();
          // Its answer was lost: read the comments again later, so the list says whether it landed.
          if (result.status === 'unknown') rereadCommentsLater(post.id);
        })
        .catch(restore)
        .finally(() => {
          inFlight.current = false;
          setStarting(false);
        });
    });

  // Stable, so a comment's row (memoized) is not drawn again for every key typed in the composer.
  const postId = post.id;
  const remove = useCallback(
    (comment: BlogCommentDTO) => {
      confirmAlert({ title: 'Delete your comment?', message: 'This can’t be undone.', confirmText: 'Delete', destructive: true })
        .then((ok) => {
          if (!ok) return;
          runWrite(deleteCommentWrite, { commentId: comment.id, postId }).catch(() => undefined);
        })
        .catch(() => undefined);
    },
    [postId],
  );
  const report = useCallback(
    (comment: BlogCommentDTO) => onReport({ docType: 'blogComment', targetId: comment.id, ownerId: comment.ownerId }),
    [onReport],
  );

  const length = Array.from(text).length;
  const tooLong = length > maxLength;
  return {
    enabled: post.commentsEnabled,
    viewerId,
    comments: shown,
    /** The list's state: reading it, failed, or read (possibly empty). */
    read: query.isPending ? ('pending' as const) : query.isError ? ('error' as const) : ('done' as const),
    retry: () => {
      query.refetch().catch(() => undefined);
    },
    canReport: canReport && viewerId !== null,
    report,
    remove,
    // The composer.
    text,
    setText,
    length,
    maxLength,
    tooLong,
    sending,
    starting,
    unconfirmed: send.status === 'unconfirmed',
    cannotSend: sending || !text.trim() || tooLong,
    submit,
    focus: () => {
      focused.current = true;
      reveal();
    },
    blur: () => {
      focused.current = false;
    },
    contentSizeChanged: reveal,
  };
}

export type BlogComments = ReturnType<typeof useBlogComments>;

/** Comments a post turned off say so. */
export function CommentsOff({ palette }: { palette: BlogPalette }) {
  return <RNText style={{ color: palette.muted, fontSize: 15, paddingVertical: 12 }}>Comments are turned off for this post.</RNText>;
}

/** The comments' title and the composer (or the sign-in prompt). */
export function CommentsHeader({ comments, palette, actionsRef }: { comments: BlogComments; palette: BlogPalette; actionsRef: RefObject<View | null> }) {
  const { viewerId, text, length, maxLength, tooLong, sending, starting, cannotSend } = comments;
  const count = comments.comments.length;
  return (
    <View style={{ gap: 8 }} testID="blog-comments">
      <RNText accessibilityRole="header" style={{ color: palette.heading, fontSize: 20, fontWeight: '700' }}>
        {count === 0 ? 'Comments' : `${count} ${count === 1 ? 'comment' : 'comments'}`}
      </RNText>
      {viewerId ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={comments.setText}
            editable={!starting}
            multiline
            placeholder="Write a comment…"
            placeholderTextColor={palette.muted}
            accessibilityLabel="Write a comment"
            onFocus={comments.focus}
            onBlur={comments.blur}
            onContentSizeChange={comments.contentSizeChanged}
            style={{ minHeight: 88, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, color: palette.text, borderRadius: 12, padding: 12, fontSize: 15, textAlignVertical: 'top' }}
            testID="blog-comment-input"
          />
          <View ref={actionsRef} collapsable={false} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <RNText style={{ flex: 1, color: tooLong ? '#dc2626' : palette.muted, fontSize: 13 }}>
              {comments.unconfirmed
                ? 'Your comment is on its way.'
                : length > maxLength - 50
                  ? `${length}/${maxLength}`
                  : ''}
            </RNText>
            <Pressable
              onPress={comments.submit}
              disabled={cannotSend}
              accessibilityRole="button"
              accessibilityLabel={sending ? 'Posting your comment' : 'Post comment'}
              accessibilityState={{ disabled: cannotSend, busy: sending }}
              style={{ minHeight: MIN_TARGET, paddingHorizontal: 18, borderRadius: 999, backgroundColor: palette.link, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: cannotSend && !sending ? 0.5 : 1 }}
              testID="blog-comment-send"
            >
              {sending ? <Spinner size="sm" color={onColor(palette.link)} /> : null}
              <RNText style={{ color: onColor(palette.link), fontWeight: '600' }}>{sending ? 'Posting…' : 'Post comment'}</RNText>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable onPress={() => requireAuth(() => undefined)} accessibilityRole="button" style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}>
          <RNText style={{ color: palette.link, fontSize: 15 }}>Sign in to comment</RNText>
        </Pressable>
      )}
    </View>
  );
}

/** What stands in for the comments until there are some: reading, failed, or none yet. */
export function CommentsState({ comments, palette }: { comments: BlogComments; palette: BlogPalette }) {
  if (comments.read === 'pending') {
    return (
      <View style={{ paddingVertical: 16 }}>
        <Spinner />
      </View>
    );
  }
  if (comments.read === 'error') {
    return (
      <Pressable onPress={comments.retry} accessibilityRole="button" style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}>
        <RNText style={{ color: palette.muted }}>{"Couldn't load comments. Tap to try again."}</RNText>
      </Pressable>
    );
  }
  return <RNText style={{ color: palette.muted, fontSize: 15, paddingVertical: 8 }}>No comments yet. Start the conversation.</RNText>;
}
