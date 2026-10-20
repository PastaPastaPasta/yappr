import type { BlogFollowDTO } from '@engine/api';
import { StatusBar } from 'expo-status-bar';
import { Pressable, Text as RNText, View } from 'react-native';
import { EllipsisHorizontalIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useViewerId } from '~/data/session';
import { runWrite, useLandingIntent } from '~/data/writes';
import { ContextMenu, type MenuItem } from '~/ui/ContextMenu';
import { MIN_TARGET } from '~/ui/tokens';

import { followBlogWrite } from './blog-writes';
import { onColor, type BlogPalette } from './blog-theme';

/** The stack header in the blog's colors (web's themed page chrome). */
export function blogHeaderOptions(palette: BlogPalette, title: string) {
  return {
    title,
    headerStyle: { backgroundColor: palette.bg },
    headerTintColor: palette.heading,
    headerTitleStyle: { color: palette.heading },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: palette.bg },
  };
}

/** The status bar over the blog's own background. */
export function BlogStatusBar({ palette }: { palette: BlogPalette }) {
  return <StatusBar style={palette.dark ? 'light' : 'dark'} />;
}

/** The follow state of a blog, read once the blog is known. */
export function useBlogFollow(blogId: string, enabled: boolean) {
  return useEngineQuery<BlogFollowDTO>(queryKeys.blog.follow(blogId), (api) => api.blogs.followState(blogId), { enabled });
}

/**
 * Follow / Following in the blog's link color (web `useBlogFollow`). Hidden
 * on the viewer's own blog; signed out it asks to sign in.
 */
export function FollowBlogButton({ blogId, ownerId, palette, follow }: { blogId: string; ownerId: string; palette: BlogPalette; follow: BlogFollowDTO | undefined }) {
  const viewerId = useViewerId();
  const landing = useLandingIntent(`blogFollow:${blogId}`);
  if (viewerId === ownerId) return null;
  const following = landing === undefined ? follow?.following === true : landing === true;
  const press = () =>
    requireAuth(() => {
      runWrite(followBlogWrite, { blogId, follow: !following }).catch(() => undefined);
    });
  return (
    <Pressable
      onPress={press}
      accessibilityRole="button"
      accessibilityState={{ selected: following }}
      accessibilityLabel={following ? 'Unfollow this blog' : 'Follow this blog'}
      style={{
        minHeight: MIN_TARGET,
        minWidth: 96,
        paddingHorizontal: 18,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: following ? palette.border : palette.link,
        backgroundColor: following ? 'transparent' : palette.link,
      }}
      testID="blog-follow"
    >
      <RNText style={{ fontWeight: '600', fontSize: 15, color: following ? palette.link : onColor(palette.link) }}>
        {following ? 'Following' : 'Follow'}
      </RNText>
    </Pressable>
  );
}

/** The "…" menu in the blog's colors. */
export function BlogMenu({ items, onSelect, palette, label, testID }: { items: MenuItem[]; onSelect: (id: string) => void; palette: BlogPalette; label: string; testID: string }) {
  if (items.length === 0) return null;
  return (
    <ContextMenu items={items} onSelect={onSelect} testID={testID}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{ width: MIN_TARGET, height: MIN_TARGET, alignItems: 'center', justifyContent: 'center' }}
      >
        <EllipsisHorizontalIcon size={24} color={palette.heading} />
      </View>
    </ContextMenu>
  );
}
