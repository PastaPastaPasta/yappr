import type { MessagingKeyDTO, PostDTO, PrivateLockReason, PrivatePostDTO } from '@engine/api';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { LockOpenIcon } from 'react-native-heroicons/outline';
import { LockClosedIcon } from 'react-native-heroicons/solid';

import { requireAuth } from '~/data/require-auth';
import { sendWrite, useLandingIntent } from '~/data/writes';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { confirmAlert } from '~/ui/Dialog';
import { MediaGrid } from '~/ui/post/MediaGrid';
import { PrivatePostPlaceholder } from '~/ui/post/PrivatePostPlaceholder';
import { RichText, type RichTextHandlers } from '~/ui/rich-text/RichText';
import { Skeleton } from '~/ui/Skeleton';
import { Text } from '~/ui/Text';
import { useColors } from '~/ui/tokens';

import { copy } from './copy';
import { canReplyTo, leaveWrite, requestAccessWrite, usePrivatePost } from './private-feed-data';

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

/** How to get the messaging key onto this phone: renew the wallet sign-in with messaging allowed, or (a key sign-in) use the wallet. */
export function MessagingKeyHelp({ messagingKey, compact = false }: { messagingKey: MessagingKeyDTO; compact?: boolean }) {
  if (messagingKey === 'ready') return null;
  return (
    <View className="gap-2" testID="private-messaging-key">
      {compact ? null : (
        <Text variant="subhead" tone="secondary">
          {messagingKey === 'allow-in-wallet' ? copy.messagingKey.allowInWallet : copy.messagingKey.unavailable}
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

/** Ask for access, or (pending) cancel the request: web's post-card Request Access and Pending. */
function RequestControl({ ownerId, reason }: { ownerId: string; reason: PrivateLockReason }) {
  // A request or cancel still on its way shows as busy (web's "Requesting…").
  const landing = useLandingIntent(`privateFeed:${ownerId}`);
  if (reason === 'pending') {
    const cancel = async () => {
      const confirmed = await confirmAlert({
        title: copy.access.cancelTitle,
        message: copy.access.cancelBody,
        confirmText: copy.access.cancel,
        cancelText: copy.access.keep,
        destructive: true,
      });
      if (confirmed) sendWrite(leaveWrite, { ownerId, member: false }, copy.access.cancelled);
    };
    return (
      <View className="flex-row flex-wrap items-center gap-2">
        <Text variant="subheadStrong" tone="warning" testID="private-pending">
          {copy.access.pending}
        </Text>
        <Button
          label={copy.access.cancel}
          variant="ghost"
          size="sm"
          loading={landing !== undefined}
          onPress={() => {
            cancel().catch(() => undefined);
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
      loading={landing !== undefined}
      layoutStyle={{ alignSelf: 'flex-start' }}
      icon={LockClosedIcon}
      onPress={() => requireAuth(() => sendWrite(requestAccessWrite, { ownerId }, copy.access.requested))}
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

/**
 * A private post's body (web `PrivatePostContent`): its public teaser, then
 * the decrypted text in a private card, or why it doesn't open with what
 * the viewer can do about it: request access, cancel a pending request,
 * get the messaging key onto this phone, or try again.
 */
export function PrivatePostBody({ post, state, failed, onRetry, variant = 'feed', tagMaxLength, ...handlers }: PrivatePostBodyProps) {
  const c = useColors();
  const teaser = teaserOf(post);
  const detail = variant === 'detail';
  const teaserText = teaser ? (
    <View className="mt-0.5">
      <RichText text={teaser} variant={detail ? 'bodyLarge' : 'body'} tagMaxLength={tagMaxLength} {...handlers} />
    </View>
  ) : null;

  if (failed || !state) {
    if (!failed) {
      return (
        <View testID="private-post-loading">
          {teaserText}
          <View className="mt-1 gap-2 rounded-xl border border-purple-200 p-3 dark:border-purple-900" accessibilityLabel="Opening private post">
            <Skeleton width="90%" />
            <Skeleton width="60%" />
          </View>
        </View>
      );
    }
    return (
      <View>
        {teaserText}
        <PrivatePostPlaceholder message={copy.post.reasons.failed}>
          <Button label={copy.post.retry} variant="outline" size="sm" layoutStyle={{ alignSelf: 'flex-start' }} onPress={onRetry} testID="private-retry" />
        </PrivatePostPlaceholder>
      </View>
    );
  }

  if (state.state === 'open') {
    const { text, image } = splitImage(state.text);
    return (
      <View testID="private-post-open">
        {teaserText}
        <View className={cn('mt-1 overflow-hidden rounded-xl border border-purple-200 dark:border-purple-900')}>
          <View className="flex-row items-center gap-1.5 bg-purple-50 px-3 py-1.5 dark:bg-purple-950/30">
            <LockOpenIcon size={14} color={c.private} />
            <Text variant="captionStrong" tone="private">
              {copy.post.open}
            </Text>
          </View>
          <View className="gap-2 px-3 py-2">
            {text ? <RichText text={text} variant={detail ? 'bodyLarge' : 'body'} tagMaxLength={tagMaxLength} {...handlers} testID="private-post-text" /> : null}
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
      </View>
    );
  }

  const { reason, feedOwnerId, own } = state;
  const reasonText = own && reason === 'history' ? copy.post.ownHistory : copy.post.reasons[reason];
  // Without the messaging key: what the viewer can do to get it.
  const keyHelp = reason === 'needs-key' && state.messagingKey !== 'ready'
    ? copy.messagingKey[state.messagingKey === 'allow-in-wallet' ? 'allowInWallet' : 'unavailable']
    : null;
  let action = null;
  if (reason === 'signed-out') {
    action = (
      <Button label="Sign in" size="sm" layoutStyle={{ alignSelf: 'flex-start' }} onPress={() => router.push('/sign-in')} testID="private-sign-in" />
    );
  } else if (reason === 'needs-key') {
    action = <MessagingKeyHelp messagingKey={state.messagingKey} compact />;
  } else if (reason === 'failed') {
    action = <Button label={copy.post.retry} variant="outline" size="sm" layoutStyle={{ alignSelf: 'flex-start' }} onPress={onRetry} testID="private-retry" />;
  } else if (!own && (reason === 'none' || reason === 'pending' || reason === 'revoked' || reason === 'key-changed')) {
    action = <RequestControl ownerId={feedOwnerId} reason={reason} />;
  }
  return (
    <View testID="private-post-locked">
      {teaserText}
      <PrivatePostPlaceholder message={keyHelp ? `${reasonText} ${keyHelp}` : reasonText}>
        {action}
      </PrivatePostPlaceholder>
    </View>
  );
}
