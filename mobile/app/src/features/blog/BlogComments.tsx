import type { BlogCommentDTO, BlogPostDTO, BlogReportTargetDTO } from '@engine/api';
import { useEffect, useRef, useState } from 'react';
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

function CommentRow({ comment, palette, own, canReport, onReport, onDelete }: {
  comment: BlogCommentDTO;
  palette: BlogPalette;
  own: boolean;
  canReport: boolean;
  onReport: () => void;
  onDelete: () => void;
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
            <Pressable onPress={onDelete} accessibilityRole="button" accessibilityLabel="Delete your comment" hitSlop={12} style={{ minHeight: MIN_TARGET, justifyContent: 'center' }} testID={`blog-comment-delete-${comment.id}`}>
              <RNText style={{ color: palette.muted, fontSize: 13 }}>Delete</RNText>
            </Pressable>
          ) : canReport ? (
            <Pressable onPress={onReport} accessibilityRole="button" accessibilityLabel="Report this comment" hitSlop={12} style={{ minHeight: MIN_TARGET, justifyContent: 'center' }} testID={`blog-comment-report-${comment.id}`}>
              <RNText style={{ color: palette.muted, fontSize: 13 }}>Report</RNText>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * A post's comments (web `blog-comments.tsx`): read, write, delete your own,
 * report others'. Comments a post turned off say so.
 */
export function BlogComments({ post, palette, maxLength, canReport, onReport, onReveal }: {
  post: BlogPostDTO;
  palette: BlogPalette;
  maxLength: number;
  canReport: boolean;
  onReport: (target: BlogReportTargetDTO) => void;
  /** Scroll the screen down by this much, to bring the Post comment button up from under the keyboard. */
  onReveal?: (dy: number) => void;
}) {
  const viewerId = useViewerId();
  const username = useSessionStore((state) => state.session?.username ?? null);
  const [typed, setTyped] = useState('');
  /** What the last tap sent, until the writer types again: given back if it fails. */
  const [sent, setSent] = useState<string | null>(null);
  const send = useWrite(commentWrite);
  const comments = useEngineQuery(queryKeys.blog.comments(post.id), (api) => api.blogs.comments(post.id), {
    enabled: post.commentsEnabled,
  });
  const shown = comments.data ?? [];
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
  const setText = (value: string) => {
    setTyped(value);
    setSent(null);
  };

  // The Post comment button sits below the field, where iOS doesn't scroll to: bring it up above the keyboard.
  const actions = useRef<View>(null);
  const focused = useRef(false);
  const keyboardTop = useRef<number | null>(null);
  const reveal = () => {
    const top = keyboardTop.current;
    if (!focused.current || top === null || !onReveal) return;
    actions.current?.measureInWindow((_x, y, _width, height) => {
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

  if (!post.commentsEnabled) {
    return <RNText style={{ color: palette.muted, fontSize: 15, paddingVertical: 12 }}>Comments are turned off for this post.</RNText>;
  }

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

  const remove = (comment: BlogCommentDTO) => {
    confirmAlert({ title: 'Delete your comment?', message: 'This can’t be undone.', confirmText: 'Delete', destructive: true })
      .then((ok) => {
        if (!ok) return;
        runWrite(deleteCommentWrite, { commentId: comment.id, postId: post.id }).catch(() => undefined);
      })
      .catch(() => undefined);
  };

  const count = shown.length;
  const length = Array.from(text).length;
  const tooLong = length > maxLength;
  const cannotSend = sending || !text.trim() || tooLong;
  return (
    <View style={{ gap: 8 }} testID="blog-comments">
      <RNText accessibilityRole="header" style={{ color: palette.heading, fontSize: 20, fontWeight: '700' }}>
        {count === 0 ? 'Comments' : `${count} ${count === 1 ? 'comment' : 'comments'}`}
      </RNText>
      {viewerId ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            editable={!starting}
            multiline
            placeholder="Write a comment…"
            placeholderTextColor={palette.muted}
            accessibilityLabel="Write a comment"
            onFocus={() => {
              focused.current = true;
              reveal();
            }}
            onBlur={() => {
              focused.current = false;
            }}
            onContentSizeChange={reveal}
            style={{ minHeight: 88, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, color: palette.text, borderRadius: 12, padding: 12, fontSize: 15, textAlignVertical: 'top' }}
            testID="blog-comment-input"
          />
          <View ref={actions} collapsable={false} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <RNText style={{ flex: 1, color: tooLong ? '#dc2626' : palette.muted, fontSize: 13 }}>
              {send.status === 'unconfirmed'
                ? 'Your comment is on its way.'
                : length > maxLength - 50
                  ? `${length}/${maxLength}`
                  : ''}
            </RNText>
            <Pressable
              onPress={submit}
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
      {comments.isPending ? (
        <View style={{ paddingVertical: 16 }}>
          <Spinner />
        </View>
      ) : comments.isError ? (
        <Pressable onPress={() => { comments.refetch().catch(() => undefined); }} accessibilityRole="button" style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}>
          <RNText style={{ color: palette.muted }}>{"Couldn't load comments. Tap to try again."}</RNText>
        </Pressable>
      ) : count === 0 ? (
        <RNText style={{ color: palette.muted, fontSize: 15, paddingVertical: 8 }}>No comments yet. Start the conversation.</RNText>
      ) : (
        shown.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            palette={palette}
            own={comment.ownerId === viewerId}
            canReport={canReport && viewerId !== null}
            onReport={() => onReport({ docType: 'blogComment', targetId: comment.id, ownerId: comment.ownerId })}
            onDelete={() => remove(comment)}
          />
        ))
      )}
    </View>
  );
}
