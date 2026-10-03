import type { ProfileDTO } from '@engine/api';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { CalendarDaysIcon, EnvelopeIcon, LinkIcon, MapPinIcon } from 'react-native-heroicons/outline';

import { openExternal } from '~/features/post/post-navigation';
import { cn, truncateId } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { IconButton } from '~/ui/IconButton';
import { Skeleton, SkeletonGroup } from '~/ui/Skeleton';
import { directionBlocks, directionStyle } from '~/ui/rich-text/direction';
import { Text } from '~/ui/Text';
import { hitSlopFor, monoFont, tw, useColors } from '~/ui/tokens';

import { ProfileBanner } from './ProfileBanner';
import { formatCount, joinedLabel, websiteLabel, websiteUrl } from './profile-format';

/** The avatar overlaps the banner by half its 88 pt diameter (UX_SPEC §4.12). */
const AVATAR_OVERLAP = 44;

export interface ProfileHeaderActions {
  onEdit: () => void;
  onFollow: () => void;
  onMessage: () => void;
  onCopyId: () => void;
  onOpenFollowers: () => void;
  onOpenFollowing: () => void;
}

export interface ProfileHeaderProps {
  profile: ProfileDTO;
  isSelf: boolean;
  /** The viewer follows this profile (signed out: false). */
  following: boolean;
  /** The viewer blocks this profile: no Message button (PRD PROF-09). */
  blocked: boolean;
  bannerHeight: number;
  bannerGated: boolean;
  actions: ProfileHeaderActions;
}

function MetaItem({ icon: Icon, children }: { icon: typeof MapPinIcon; children: ReactNode }) {
  const c = useColors();
  return (
    <View className="max-w-full flex-row items-center gap-1">
      <Icon size={16} color={c.textSecondary} />
      {children}
    </View>
  );
}

function Count({ count, label, onPress, testID }: { count: number; label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${formatCount(count)} ${label}`}
      hitSlop={hitSlopFor(20)}
      onPress={onPress}
      testID={testID}
      className="flex-row items-baseline gap-1 active:opacity-60"
    >
      <Text variant="bodyStrong" tone="emphasis" tabular>
        {formatCount(count)}
      </Text>
      <Text variant="subhead" tone="secondary">
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The profile header (PRD PROF-01, UX_SPEC §4.12): banner, ringed avatar,
 * the Edit or Message + Follow buttons, name, handle and pronouns, bio,
 * location / website / joined, and the Following and Followers counts.
 */
export function ProfileHeader({
  profile,
  isSelf,
  following,
  blocked,
  bannerHeight,
  bannerGated,
  actions,
}: ProfileHeaderProps) {
  // Nameless: no DPNS name and no profile name, so the truncated id is the name (PRD AUTH-15).
  const nameless = !profile.username && !profile.hasProfile;
  const website = websiteUrl(profile.website);
  const joined = joinedLabel(profile.joinedAt);
  const aliases = profile.usernames.slice(1);

  const handle = profile.username ? (
    <Text variant="subhead" tone="secondary" testID="profile-handle">
      @{profile.username}
    </Text>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Copy identity ID"
      accessibilityHint={profile.id}
      onPress={actions.onCopyId}
      hitSlop={hitSlopFor(20)}
      testID="profile-copy-id"
      className="active:opacity-60"
    >
      <Text variant={nameless ? 'titleProfile' : 'subhead'} tone={nameless ? 'emphasis' : 'secondary'} style={monoFont}>
        {truncateId(profile.id)}
      </Text>
    </Pressable>
  );

  return (
    <View testID="profile-header">
      <ProfileBanner uri={profile.bannerUrl} gated={bannerGated} height={bannerHeight} />
      <View className="px-4">
        <View className="flex-row items-end justify-between" style={{ marginTop: -AVATAR_OVERLAP }}>
          <Avatar avatar={profile.avatar} identityId={profile.id} size="profile" testID="profile-avatar" />
          <View className="flex-row items-center gap-2 pb-1">
            {isSelf ? (
              <Button label="Edit profile" variant="outline" size="sm" onPress={actions.onEdit} testID="profile-edit" />
            ) : (
              <>
                {blocked ? null : (
                  <IconButton
                    icon={EnvelopeIcon}
                    accessibilityLabel={`Message ${profile.displayName}`}
                    onPress={actions.onMessage}
                    className={cn('h-8 w-8 border', tw.borderStrong)}
                    iconSize={18}
                    testID="profile-message"
                  />
                )}
                <Button
                  label={following ? 'Following' : 'Follow'}
                  accessibilityLabel={`${following ? 'Following' : 'Follow'} ${profile.displayName}`}
                  variant={following ? 'outline' : 'primary'}
                  size="sm"
                  onPress={actions.onFollow}
                  testID="profile-follow"
                />
              </>
            )}
          </View>
        </View>

        <View className="mt-3 gap-1">
          {nameless ? (
            handle
          ) : (
            <>
              <Text variant="titleProfile" tone="emphasis" accessibilityRole="header" testID="profile-name">
                {profile.displayName}
              </Text>
              <View className="flex-row flex-wrap items-center gap-x-1.5">
                {handle}
                {profile.pronouns ? (
                  <Text variant="subhead" tone="secondary">
                    · {profile.pronouns}
                  </Text>
                ) : null}
              </View>
            </>
          )}
          {nameless && profile.pronouns ? (
            <Text variant="subhead" tone="secondary">
              {profile.pronouns}
            </Text>
          ) : null}
          {aliases.length > 0 ? (
            <Text variant="caption" tone="secondary">
              Also known as {aliases.map((name) => `@${name}`).join(', ')}
            </Text>
          ) : null}
        </View>

        {profile.bio ? (
          // One <Text> per run of same-direction paragraphs, so RTL ones align right (PRD G-9).
          <View className="mt-3" testID="profile-bio">
            {directionBlocks(profile.bio).map((block, i) => (
              <Text key={i} style={directionStyle(block.direction)}>
                {block.text}
              </Text>
            ))}
          </View>
        ) : null}

        {profile.location || website || joined ? (
          <View className="mt-3 flex-row flex-wrap gap-x-4 gap-y-1.5">
            {profile.location ? (
              <MetaItem icon={MapPinIcon}>
                <Text variant="subhead" tone="secondary" numberOfLines={1}>
                  {profile.location}
                </Text>
              </MetaItem>
            ) : null}
            {website && profile.website ? (
              <MetaItem icon={LinkIcon}>
                <Text
                  variant="subhead"
                  tone="link"
                  numberOfLines={1}
                  accessibilityRole="link"
                  onPress={() => openExternal(website)}
                  testID="profile-website"
                >
                  {websiteLabel(profile.website)}
                </Text>
              </MetaItem>
            ) : null}
            {joined ? (
              <MetaItem icon={CalendarDaysIcon}>
                <Text variant="subhead" tone="secondary">
                  {joined}
                </Text>
              </MetaItem>
            ) : null}
          </View>
        ) : null}

        <View className="mb-3 mt-3 flex-row gap-5">
          <Count
            count={profile.stats.following}
            label="Following"
            onPress={actions.onOpenFollowing}
            testID="profile-following-count"
          />
          <Count
            count={profile.stats.followers}
            label={profile.stats.followers === 1 ? 'Follower' : 'Followers'}
            onPress={actions.onOpenFollowers}
            testID="profile-followers-count"
          />
        </View>
      </View>
    </View>
  );
}

/** Loading (UX_SPEC §4.12): the gradient, an avatar circle and two bars where the name and handle go. */
export function ProfileHeaderSkeleton({ bannerHeight }: { bannerHeight: number }) {
  return (
    <SkeletonGroup label="Loading profile" testID="profile-header-skeleton">
      <ProfileBanner height={bannerHeight} />
      <View className="px-4 pb-4">
        <View style={{ marginTop: -AVATAR_OVERLAP }} className={cn('self-start rounded-full border-4', 'border-white dark:border-neutral-900')}>
          <Skeleton circle height={80} />
        </View>
        <View className="mt-3 gap-2">
          <Skeleton width={160} height={20} />
          <Skeleton width={110} />
          <Skeleton width="85%" className="mt-2" />
          <View className="mt-2 flex-row gap-5">
            <Skeleton width={80} />
            <Skeleton width={80} />
          </View>
        </View>
      </View>
    </SkeletonGroup>
  );
}
