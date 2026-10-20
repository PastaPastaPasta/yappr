import type { MessagingKeyDTO, PostDTO, PrivateLockReason, PrivatePostDTO } from '@engine/api';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { LockOpenIcon } from 'react-native-heroicons/outline';
import { LockClosedIcon } from 'react-native-heroicons/solid';

import { useLandingIntent } from '~/data/writes';
import { Button } from '~/ui/Button';
import { MediaGrid } from '~/ui/post/MediaGrid';
import { PrivatePostPlaceholder } from '~/ui/post/PrivatePostPlaceholder';
import { RichText, type RichTextHandlers } from '~/ui/rich-text/RichText';
import { Skeleton } from '~/ui/Skeleton';
import { Text } from '~/ui/Text';
import { useColors } from '~/ui/tokens';

import { copy } from './copy';
import { accessKey, canReplyTo, confirmLeave, messagingKeyText, requestAccess, usePrivatePost } from './private-feed-data';

/** Web hides these teasers: they are the lock a post without one used to carry. */
const LOCK_TEASERS = new Set([':lock:', '🔒']);

/** The public teaser a private post shows everyone, or null. */
export function teaserOf(post: Pick<PostDTO, 'content'>): string | null {
  const teaser = post.content.trim();
  return teaser && !LOCK_TEASERS.has(teaser) ? teaser : null;
}

/** An encrypted post's image link rides at the end of its text (lib `planPosts`): shown as the image, not the link. */
const TRAILING_IMAGE = /\n\n((?:https|ipfs):\/\/\S+)\s*$/;

export function splitImage(text: string): { text: string; image: string | null } {
  const match = TRAILING_IMAGE.exec(text);
  return match ? { text: text.slice(0, match.index).trimEnd(), image: match[1] } : { text, image: null };
}

/**
 * How to get the messaging key onto this phone: the sentence (unless
 * `compact`, where the caller says it), and for a wallet sign-in, renewing
 * it with messaging allowed.
 */
export function MessagingKeyHelp({ messagingKey, compact = false }: { messagingKey: MessagingKeyDTO; compact?: boolean }) {
  const text = messagingKeyText(messagingKey);
  if (text === null) return null;
  return (
    <View className="gap-2" testID="private-messaging-key">
      {compact ? null : (
        <Text variant="subhead" tone="secondary">
          {text}
        </Text>
      )}
      {messagingKey === 'allow-in-wallet' ? (
        <Button
          label={copy.messagingKey.renew}
          variant="outline"
          size="sm"
          layoutStyle={{ alignSelf: 'flex-start' }}
          onPress={() => router.push('/sign-in/renew')}
          testID="private-renew-wallet"
        />
      ) : null}
    </View>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      label={copy.post.retry}
      variant="outline"
      size="sm"
      layoutStyle={{ alignSelf: 'flex-start' }}
      onPress={onRetry}
      testID="private-retry"
    />
  );
}

/** Ask for access, or (pending) cancel the request: web's post-card Request Access and Pending. */
function RequestControl({ ownerId, reason }: { ownerId: string; reason: PrivateLockReason }) {
  // A request or cancel still on its way shows as busy (web's "Requesting…").
  const busy = useLandingIntent(accessKey(ownerId)) !== undefined;
  if (reason === 'pending') {
    return (
      <View className="flex-row flex-wrap items-center gap-2">
        <Text variant="subheadStrong" tone="warning" testID="private-pending">
          {copy.access.pending}
        </Text>
        <Button
          label={copy.access.cancel}
          variant="ghost"
          size="sm"
          loading={busy}
          onPress={() => {
            confirmLeave(ownerId, false).catch(() => undefined);
          }}
          testID="private-cancel-request"
        />
      </View>
    );
  }
  return (
    <Button
      label={reason === 'none' ? copy.access.request : copy.access.requestAgain}
      size="sm"
      loading={busy}
      layoutStyle={{ alignSelf: 'flex-start' }}
      icon={LockClosedIcon}
      onPress={() => requestAccess(ownerId)}
      testID="private-request-access"
    />
  );
}

/**
 * What a post card needs for a private post (`PostCard`'s `privateBody`,
 * `canReply` and `privateText`): its body, read through `privateFeed.read`.
 * Nothing for a public post.
 */
export function usePrivateBody(
  post: PostDTO,
  options: { variant?: 'feed' | 'detail'; tagMaxLength?: number; handlers?: RichTextHandlers } = {},
): { privateBody?: ReactNode; canReply?: boolean; privateText?: string } {
  const read = usePrivatePost(post);
  if (!post.encrypted) return {};
  const state = read.data;
  return {
    privateBody: (
      <PrivatePostBody
        post={post}
        state={state}
        failed={read.isError}
        onRetry={() => {
          read.refetch().catch(() => undefined);
        }}
        variant={options.variant}
        tagMaxLength={options.tagMaxLength}
        {...options.handlers}
      />
    ),
    canReply: canReplyTo(post, state),
    privateText: state?.state === 'open' ? splitImage(state.text).text : undefined,
  };
}

export interface PrivatePostBodyProps extends RichTextHandlers {
  post: PostDTO;
  /** `privateFeed.read`'s answer; undefined while it loads. */
  state: PrivatePostDTO | undefined;
  /** The read failed (it rejects only when the post itself could not be read). */
  failed: boolean;
  onRetry: () => void;
  variant?: 'feed' | 'detail';
  tagMaxLength?: number;
}

/** The decrypted post in its private card; for the owner, who it reaches. */
function OpenBody({ state, detail, tagMaxLength, handlers }: {
  state: Extract<PrivatePostDTO, { state: 'open' }>;
  detail: boolean;
  tagMaxLength?: number;
  handlers: RichTextHandlers;
}) {
  const c = useColors();
  const { text, image } = splitImage(state.text);
  return (
    <View className="mt-1 overflow-hidden rounded-xl border border-purple-200 dark:border-purple-900">
      <View className="flex-row items-center gap-1.5 bg-purple-50 px-3 py-1.5 dark:bg-purple-950/30">
        <LockOpenIcon size={14} color={c.private} />
        <Text variant="captionStrong" tone="private">
          {copy.post.open}
        </Text>
      </View>
      <View className="gap-2 px-3 py-2">
        {text ? (
          <RichText text={text} variant={detail ? 'bodyLarge' : 'body'} tagMaxLength={tagMaxLength} {...handlers} testID="private-post-text" />
        ) : null}
        {image ? <MediaGrid media={[{ type: 'image', url: image }]} gated={false} /> : null}
      </View>
      {state.own && state.followerCount !== null ? (
        <View className="flex-row items-center gap-1.5 border-t border-purple-200 px-3 py-1.5 dark:border-purple-900">
          <LockClosedIcon size={12} color={c.textSecondary} />
          <Text variant="caption" tone="secondary" testID="private-post-audience">
            {copy.post.followers(state.followerCount)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Why it is locked, and what the viewer can do about it. */
function LockedBody({ state, onRetry }: { state: Extract<PrivatePostDTO, { state: 'locked' }>; onRetry: () => void }) {
  const { reason, feedOwnerId, own } = state;
  const reasonText = own && reason === 'history' ? copy.post.ownHistory : copy.post.reasons[reason];
  // Without the messaging key: what the viewer can do to get it.
  const keyHelp = reason === 'needs-key' ? messagingKeyText(state.messagingKey) : null;
  let action: ReactNode = null;
  if (reason === 'signed-out') {
    action = <Button label="Sign in" size="sm" layoutStyle={{ alignSelf: 'flex-start' }} onPress={() => router.push('/sign-in')} testID="private-sign-in" />;
  } else if (reason === 'needs-key') {
    action = <MessagingKeyHelp messagingKey={state.messagingKey} compact />;
  } else if (reason === 'failed') {
    action = <RetryButton onRetry={onRetry} />;
  } else if (!own && (reason === 'none' || reason === 'pending' || reason === 'revoked' || reason === 'key-changed')) {
    action = <RequestControl ownerId={feedOwnerId} reason={reason} />;
  }
  return (
    <PrivatePostPlaceholder message={keyHelp ? `${reasonText} ${keyHelp}` : reasonText}>{action}</PrivatePostPlaceholder>
  );
}

/**
 * A private post's body (web `PrivatePostContent`): its public teaser, then
 * the decrypted text in a private card, or why it doesn't open with what
 * the viewer can do about it: request access, cancel a pending request,
 * get the messaging key onto this phone, or try again.
 */
export function PrivatePostBody({ post, state, failed, onRetry, variant = 'feed', tagMaxLength, ...handlers }: PrivatePostBodyProps) {
  const teaser = teaserOf(post);
  const detail = variant === 'detail';
  let body: ReactNode;
  let testID: string;
  if (failed) {
    testID = 'private-post-locked';
    body = (
      <PrivatePostPlaceholder message={copy.post.reasons.failed}>
        <RetryButton onRetry={onRetry} />
      </PrivatePostPlaceholder>
    );
  } else if (!state) {
    testID = 'private-post-loading';
    body = (
      <View className="mt-1 gap-2 rounded-xl border border-purple-200 p-3 dark:border-purple-900" accessibilityLabel="Opening private post">
        <Skeleton width="90%" />
        <Skeleton width="60%" />
      </View>
    );
  } else if (state.state === 'open') {
    testID = 'private-post-open';
    body = <OpenBody state={state} detail={detail} tagMaxLength={tagMaxLength} handlers={handlers} />;
  } else {
    testID = 'private-post-locked';
    body = <LockedBody state={state} onRetry={onRetry} />;
  }
  return (
    <View testID={testID}>
      {teaser ? (
        <View className="mt-0.5">
          <RichText text={teaser} variant={detail ? 'bodyLarge' : 'body'} tagMaxLength={tagMaxLength} {...handlers} />
        </View>
      ) : null}
      {body}
    </View>
  );
}
