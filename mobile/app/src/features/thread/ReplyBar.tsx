import type { PostDTO } from '@engine/api/dto';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useSession } from '~/data/session';
import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

/** Why the focus takes no replies; `null` when it does. */
export type ReplyBlock = 'deleted' | 'private' | null;

export function replyBlockOf(post: PostDTO | undefined, removedHere: boolean): ReplyBlock {
  if (!post) return null;
  if (post.deleted || removedHere) return 'deleted';
  return post.encrypted ? 'private' : null;
}

function BarFrame({ children }: { children: ReactNode }) {
  return <View className={cn('min-h-[52px] justify-center border-t', tw.border, tw.bg)}>{children}</View>;
}

/** The viewer's avatar, from their cached profile. */
function ViewerAvatar({ identityId }: { identityId: string }) {
  const { data: profile } = useEngineQuery(
    queryKeys.profile.detail(identityId),
    (api) => api.profiles.get(identityId),
    { persist: true, staleTime: 5 * 60_000 },
  );
  return <Avatar avatar={profile?.avatar} identityId={identityId} size="sm" />;
}

/**
 * The docked "Post your reply" bar under a thread (PRD POST-10, UX_SPEC
 * §4.9): opens compose in reply mode for the focused post. Signed out it
 * reads "Sign in to reply"; a deleted post shows why it takes no replies;
 * a private post (no replies in 1.0) shows nothing.
 */
export function ReplyBar({ post, block }: { post: PostDTO; block: ReplyBlock }) {
  const { status, identityId } = useSession();
  if (block === 'private') return null;
  if (block === 'deleted') {
    return (
      <BarFrame>
        <Text variant="subhead" tone="secondary" className="px-4 text-center" testID="reply-bar-deleted">
          This post was deleted, so it can&apos;t be replied to.
        </Text>
      </BarFrame>
    );
  }
  const signedOut = status === 'signed-out';
  const label = signedOut ? 'Sign in to reply' : 'Post your reply';
  const postId = post.id;
  return (
    <BarFrame>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => requireAuth(() => router.push({ pathname: '/compose', params: { replyTo: postId } }))}
        testID="reply-bar"
        className={cn('min-h-[52px] flex-row items-center gap-3 px-4', tw.pressed)}
      >
        {identityId && !signedOut ? <ViewerAvatar identityId={identityId} /> : null}
        <Text variant="body" tone="placeholder" className="flex-1" numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </BarFrame>
  );
}
