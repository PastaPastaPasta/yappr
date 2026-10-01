import { Pressable, View } from 'react-native';

import { truncateId } from '~/lib-allowlist';

import { Avatar } from './Avatar';
import { Tag } from './Badge';
import { Button } from './Button';
import { Text } from './Text';
import { monoFont, useLargeText } from './tokens';

/** The fields a user row needs; the engine's AuthorDTO / ProfileDTO both carry them. */
export interface UserRowUser {
  id: string;
  displayName: string;
  username: string | null;
  avatarUrl?: string;
  bio?: string;
}

export interface UserRowProps {
  user: UserRowUser;
  /** The viewer's own row: no follow button. */
  isSelf?: boolean;
  following?: boolean;
  followsYou?: boolean;
  followLoading?: boolean;
  onFollowPress?: () => void;
  onPress?: () => void;
  testID?: string;
}

/** "Follow", "Follow back" or "Following" (UX_SPEC §2.10). */
export function followLabel(following: boolean, followsYou: boolean): string {
  if (following) return 'Following';
  return followsYou ? 'Follow back' : 'Follow';
}

/**
 * A person in a list (followers, search, engagements): avatar, name,
 * @handle, "Follows you", a two-line bio and the follow button. At
 * accessibility text sizes the button moves under the text.
 */
export function UserRow({
  user,
  isSelf = false,
  following = false,
  followsYou = false,
  followLoading = false,
  onFollowPress,
  onPress,
  testID,
}: UserRowProps) {
  const largeText = useLargeText();
  const handle = user.username ? `@${user.username}` : truncateId(user.id);
  const canFollow = !isSelf && !!onFollowPress && !followLoading;
  const followButton =
    isSelf || !onFollowPress ? null : (
      <Button
        size="sm"
        variant={following ? 'outline' : 'primary'}
        label={followLabel(following, followsYou)}
        accessibilityLabel={`${followLabel(following, followsYou)} ${user.displayName}`}
        loading={followLoading}
        onPress={onFollowPress}
        testID={testID ? `${testID}-follow` : undefined}
      />
    );

  return (
    // One screen-reader element (a parent hides its children on iOS), with
    // following as a custom action.
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[user.displayName, handle, followsYou && 'follows you', user.bio].filter(Boolean).join(', ')}
      accessibilityActions={canFollow ? [{ name: 'follow', label: followLabel(following, followsYou) }] : undefined}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'follow') onFollowPress?.();
      }}
      onPress={onPress}
      testID={testID}
      className="min-h-[72px] flex-row gap-3 px-4 py-3 active:bg-gray-50 dark:active:bg-gray-950"
    >
      <Avatar uri={user.avatarUrl} size="md" />
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-start gap-3">
          <View className="flex-1">
            <Text variant="bodyStrong" numberOfLines={largeText ? undefined : 1}>
              {user.displayName}
            </Text>
            <View className="flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <Text
                variant="subhead"
                tone="secondary"
                numberOfLines={1}
                style={user.username ? undefined : monoFont}
              >
                {handle}
              </Text>
              {followsYou ? <Tag label="Follows you" /> : null}
            </View>
          </View>
          {largeText ? null : followButton}
        </View>
        {user.bio ? (
          <Text variant="subhead" numberOfLines={2}>
            {user.bio}
          </Text>
        ) : null}
        {largeText && followButton ? <View className="mt-2 self-start">{followButton}</View> : null}
      </View>
    </Pressable>
  );
}
