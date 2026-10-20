import type { MessagingKeyDTO, PostDTO, PrivateLockReason, PrivatePostDTO } from '@engine/api';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { LockOpenIcon } from 'react-native-heroicons/outline';
import { LockClosedIcon } from 'react-native-heroicons/solid';

import { useViewerId } from '~/data/session';
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
const TRAILING_LINK = /\n\n((?:https|ipfs):\/\/\S+)\s*$/;
/** lib/link-preview/urls.ts `IMAGE_EXTENSIONS`: an https link names an image by its path. */
const IMAGE_PATH = /\.(jpe?g|png|gif|webp|bmp|svg|ico|avif)$/i;

/** Whether a trailing link is the attached image (an IPFS link, or an image's https link), not a link someone wrote. */
function isImageLink(url: string): boolean {
  if (url.startsWith('ipfs://')) return true;
  try {
    return IMAGE_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function splitImage(text: string): { text: string; image: string | null } {
  const match = TRAILING_LINK.exec(text);
  return match && isImageLink(match[1]) ? { text: text.slice(0, match.index).trimEnd(), image: match[1] } : { text, image: null };
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
  options: {
    variant?: 'feed' | 'detail';
    tagMaxLength?: number;
    handlers?: RichTextHandlers;
    enabled?: boolean;
    /** The post's media gate (`usePostSafety`): a decrypted image waits for it like any other. */
    mediaGated?: boolean;
    onRevealMedia?: () => void;
  } = {},
): {
  privateBody?: ReactNode;
  canReply?: boolean;
  privateText?: string;
  privateAction?: { label: string; run: () => void };
  /** Known to be locked for the viewer (not their own post): a list may leave it out. */
  unreadable?: boolean;
  /** The decrypted post has an image (behind the media gate, if any). */
  privateMedia?: boolean;
} {
  const read = usePrivatePost(post, options.enabled);
  const viewerId = useViewerId();
  if (!post.encrypted) return {};
  const state = read.data;
  const retry = () => {
    read.refetch().catch(() => undefined);
  };
  return {
    privateAction: privateActionOf(state, read.isError, retry),
    // Only what the viewer can't read for want of access: never their own post or reply, a failed read,
    // nor a feed they're approved for but read elsewhere (no messaging key here).
    privateMedia: state?.state === 'open' && splitImage(state.text).image !== null,
    unreadable:
      state?.state === 'locked' && !state.own && post.author.id !== viewerId && HIDEABLE.has(state.reason),
    privateBody: (
      <PrivatePostBody
        post={post}
        state={state}
        failed={read.isError}
        onRetry={retry}
        variant={options.variant}
        tagMaxLength={options.tagMaxLength}
        mediaGated={options.mediaGated ?? false}
        onRevealMedia={options.onRevealMedia}
        {...options.handlers}
      />
    ),
    canReply: canReplyTo(post, state),
    privateText: state?.state === 'open' ? splitImage(state.text).text : undefined,
  };
}

/**
 * The viewer's own private post or reply while it posts (its optimistic card):
 * the public teaser, if any, and who will see it. The card keeps no private text.
 */
export function PendingPrivateBody({ post }: { post: Pick<PostDTO, 'content' | 'kind'> }) {
  const teaser = teaserOf(post);
  return (
    <View testID="private-post-posting">
      {teaser ? (
        <View className="mt-0.5">
          <RichText text={teaser} variant="body" />
        </View>
      ) : null}
      <PrivatePostPlaceholder message={post.kind === 'reply' ? copy.post.postingReply : copy.post.posting} />
    </View>
  );
}

/** Locked for want of access, so a list may leave it out ("Hide private posts I can't see"). */
const HIDEABLE: ReadonlySet<PrivateLockReason> = new Set(['none', 'pending', 'revoked', 'history', 'key-changed']);

/** The locked panel's button as a screen-reader action of its card (see `LockedBody`); none when it opens. */
function privateActionOf(state: PrivatePostDTO | undefined, failed: boolean, retry: () => void): { label: string; run: () => void } | undefined {
  if (failed) return { label: copy.post.retry, run: retry };
  if (state?.state !== 'locked') return undefined;
  const { reason, feedOwnerId, own } = state;
  if (reason === 'signed-out') return { label: 'Sign in', run: () => router.push('/sign-in') };
  if (reason === 'needs-key') {
    return state.messagingKey === 'allow-in-wallet'
      ? { label: copy.messagingKey.renew, run: () => router.push('/sign-in/renew') }
      : undefined;
  }
  if (reason === 'failed') return { label: copy.post.retry, run: retry };
  if (own) return undefined;
  if (reason === 'pending') return { label: copy.access.cancel, run: () => confirmLeave(feedOwnerId, false).catch(() => undefined) };
  if (reason === 'none') return { label: copy.access.request, run: () => requestAccess(feedOwnerId) };
  if (reason === 'revoked' || reason === 'key-changed') return { label: copy.access.requestAgain, run: () => requestAccess(feedOwnerId) };
  return undefined;
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
  mediaGated?: boolean;
  onRevealMedia?: () => void;
}

/**
 * While a private post opens: the locked card's shape (its box, title, a
 * line and a button), what most viewers get, so little moves when it lands.
 */
function PrivatePostSkeleton() {
  const c = useColors();
  return (
    <View
      className="mt-1 gap-1 rounded-xl border border-purple-200 bg-purple-50 p-3 dark:border-purple-900 dark:bg-purple-950/30"
      accessible
      accessibilityLabel="Opening private post"
    >
      <View className="flex-row items-center gap-1.5">
        <LockClosedIcon size={16} color={c.private} />
        <Text variant="subheadStrong" tone="private">
          Private post
        </Text>
      </View>
      <View className="h-5 justify-center">
        <Skeleton width="80%" />
      </View>
      <View className="mt-1">
        <Skeleton width={136} height={32} />
      </View>
    </View>
  );
}

/** The decrypted post in its private card; for the owner, who it reaches. */
function OpenBody({ state, detail, tagMaxLength, handlers, mediaGated, onRevealMedia }: {
  state: Extract<PrivatePostDTO, { state: 'open' }>;
  detail: boolean;
  tagMaxLength?: number;
  handlers: RichTextHandlers;
  mediaGated: boolean;
  onRevealMedia?: () => void;
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
        {image ? <MediaGrid media={[{ type: 'image', url: image }]} gated={mediaGated} onReveal={onRevealMedia} /> : null}
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
export function PrivatePostBody({
  post,
  state,
  failed,
  onRetry,
  variant = 'feed',
  tagMaxLength,
  mediaGated = false,
  onRevealMedia,
  ...handlers
}: PrivatePostBodyProps) {
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
    body = <PrivatePostSkeleton />;
  } else if (state.state === 'open') {
    testID = 'private-post-open';
    body = (
      <OpenBody
        state={state}
        detail={detail}
        tagMaxLength={tagMaxLength}
        handlers={handlers}
        mediaGated={mediaGated}
        onRevealMedia={onRevealMedia}
      />
    );
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
