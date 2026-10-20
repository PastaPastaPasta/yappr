import type { BlogCommentDTO, BlogPostDTO, BlogReportTargetDTO } from '@engine/api';
import { useRef, useState } from 'react';
import { Pressable, Text as RNText, TextInput, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useViewerId } from '~/data/session';
import { runWrite, useWrite } from '~/data/writes';
import { openUser } from '~/features/post/post-navigation';
import { Avatar } from '~/ui/Avatar';
import { confirmAlert } from '~/ui/Dialog';
import { handleOf } from '~/ui/handle';
import { Spinner } from '~/ui/Spinner';
import { MIN_TARGET } from '~/ui/tokens';
import { useRelativeTime } from '~/ui/use-relative-time';

import { commentWrite, deleteCommentWrite } from './blog-writes';
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
  return (
    <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 12, borderTopWidth: 1, borderColor: palette.border }} testID={`blog-comment-${comment.id}`}>
      <Avatar avatar={comment.author?.avatar} identityId={comment.ownerId} size="sm" name={name} onPress={() => openUser(comment.ownerId)} />
      <View style={{ flex: 1, gap: 4 }}>
        <RNText style={{ color: palette.muted, fontSize: 13 }} numberOfLines={1}>
          <RNText style={{ color: palette.heading, fontWeight: '600' }}>{name}</RNText>
          {handle && handle !== name ? ` ${handle}` : ''} · {when}
        </RNText>
        <RNText selectable style={{ color: palette.text, fontSize: 15, lineHeight: 21 }}>{comment.content}</RNText>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          {own ? (
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
export function BlogComments({ post, palette, maxLength, canReport, onReport }: {
  post: BlogPostDTO;
  palette: BlogPalette;
  maxLength: number;
  canReport: boolean;
  onReport: (target: BlogReportTargetDTO) => void;
}) {
  const viewerId = useViewerId();
  const [draft, setDraft] = useState('');
  /** The sent comment's ticket the writer has typed past (its text was cleared when it went out). */
  const [typedAfter, setTypedAfter] = useState<string | null>(null);
  const send = useWrite(commentWrite);
  const comments = useEngineQuery(queryKeys.blog.comments(post.id), (api) => api.blogs.comments(post.id), {
    enabled: post.commentsEnabled,
  });
  const shown = comments.data ?? [];
  // From the tap, before the engine answers with a ticket, to the ticket settling: one comment at a time.
  const [starting, setStarting] = useState(false);
  const inFlight = useRef(false);
  const sending = starting || send.status === 'pending';

  // A sent comment clears the field once the network has it.
  const sent = (send.status === 'confirmed' || send.status === 'unconfirmed') && send.ticket !== null && typedAfter !== send.ticket.id;
  const text = sent ? '' : draft;
  const setText = (value: string) => {
    setDraft(value);
    if (send.ticket) setTypedAfter(send.ticket.id);
  };

  if (!post.commentsEnabled) {
    return <RNText style={{ color: palette.muted, fontSize: 15, paddingVertical: 12 }}>Comments are turned off for this post.</RNText>;
  }

  const submit = () =>
    requireAuth(() => {
      const content = text.trim();
      // A ref, not state: a second tap in the same frame still sees the first.
      if (!content || inFlight.current || send.status === 'pending') return;
      inFlight.current = true;
      setStarting(true);
      send
        .send({ postId: post.id, postOwnerId: post.ownerId, content })
        .then((result) => {
          // It may have landed with no ticket to follow: clear the text rather than offer to send it again.
          if (result.status === 'unknown') setDraft('');
        })
        .catch(() => undefined)
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
            editable={!sending}
            multiline
            placeholder="Write a comment…"
            placeholderTextColor={palette.muted}
            accessibilityLabel="Write a comment"
            style={{ minHeight: 88, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, color: palette.text, borderRadius: 12, padding: 12, fontSize: 15, textAlignVertical: 'top' }}
            testID="blog-comment-input"
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
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
              accessibilityState={{ disabled: cannotSend, busy: sending }}
              style={{ minHeight: MIN_TARGET, paddingHorizontal: 18, borderRadius: 999, backgroundColor: palette.link, justifyContent: 'center', opacity: cannotSend ? 0.5 : 1 }}
              testID="blog-comment-send"
            >
              {sending ? <Spinner size="sm" color={onColor(palette.link)} /> : <RNText style={{ color: onColor(palette.link), fontWeight: '600' }}>Post comment</RNText>}
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
