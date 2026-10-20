import type { BlogDTO, BlogPostSummaryDTO } from '@engine/api';
import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, View } from 'react-native';

import { cn } from '~/lib-allowlist';
import { Avatar } from '~/ui/Avatar';
import { handleOf } from '~/ui/handle';
import { useMediaUrls } from '~/ui/media-url';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import { openBlog, openBlogPost } from './blog-navigation';

const shortDate = (date: Date) =>
  new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** "Oct 18, 2026 · 4 min read", or "Draft" for an unpublished post. */
export function postMeta(post: Pick<BlogPostSummaryDTO, 'publishedAt' | 'date' | 'readingMinutes'>): string {
  const when = post.publishedAt ? shortDate(post.date) : 'Draft';
  return `${when} · ${post.readingMinutes} min read`;
}

/** A blog's avatar: its own image, else its author's avatar. */
export function BlogAvatar({ blog, size = 'md' }: { blog: Pick<BlogDTO, 'avatar' | 'ownerId' | 'owner' | 'name'>; size?: 'sm' | 'md' | 'xl' }) {
  const urls = useMediaUrls();
  const source = urls.media(blog.avatar, 'avatar');
  const px = size === 'xl' ? 64 : size === 'md' ? 40 : 32;
  if (source) {
    return (
      <Image
        source={{ uri: source }}
        style={{ width: px, height: px, borderRadius: px / 2 }}
        accessibilityLabel={`${blog.name} avatar`}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return <Avatar avatar={blog.owner?.avatar} identityId={blog.ownerId} size={size} />;
}

/** A blog in a list: avatar, name, description and author (web `blog-discovery.tsx`). */
export const BlogRow = memo(function BlogRow({ blog, onPress }: { blog: BlogDTO; onPress?: () => void }) {
  const author = blog.owner ? (blog.owner.username ? handleOf(blog.owner) : blog.owner.displayName) : null;
  return (
    <Pressable
      onPress={onPress ?? (() => openBlog(blog.id))}
      accessibilityRole="button"
      accessibilityLabel={`${blog.name}${author ? `, by ${author}` : ''}`}
      className={cn('flex-row items-center gap-3 border-b px-4 py-3 active:bg-gray-50 dark:active:bg-gray-950', tw.border)}
      testID={`blog-row-${blog.id}`}
    >
      <BlogAvatar blog={blog} />
      <View className="flex-1 gap-0.5">
        <Text variant="bodyStrong" numberOfLines={1}>{blog.name}</Text>
        {blog.description ? <Text variant="subhead" tone="secondary" numberOfLines={2}>{blog.description}</Text> : null}
        {author ? <Text variant="caption" tone="secondary" numberOfLines={1}>{author}</Text> : null}
      </View>
    </Pressable>
  );
});

/** A post in a list: cover, title, excerpt and date (web `blog-post-card.tsx`). */
export const PostCard = memo(function PostCard({ post, showBlog = false }: { post: BlogPostSummaryDTO; showBlog?: boolean }) {
  const urls = useMediaUrls();
  const cover = urls.media(post.coverImage, 'thumbnail');
  return (
    <Pressable
      onPress={() => openBlogPost(post.blogId, post.slug)}
      accessibilityRole="button"
      accessibilityLabel={`${post.title}${showBlog && post.blogName ? `, in ${post.blogName}` : ''}`}
      className={cn('flex-row gap-3 border-b px-4 py-3 active:bg-gray-50 dark:active:bg-gray-950', tw.border)}
      testID={`blog-post-${post.slug}`}
    >
      <View className="flex-1 gap-1">
        {showBlog && post.blogName ? <Text variant="captionStrong" tone="secondary" numberOfLines={1}>{post.blogName}</Text> : null}
        <Text variant="bodyStrong" numberOfLines={2}>{post.title}</Text>
        {post.excerpt ? <Text variant="subhead" tone="secondary" numberOfLines={2}>{post.excerpt}</Text> : null}
        <Text variant="caption" tone="secondary">{postMeta(post)}</Text>
      </View>
      {cover ? (
        <Image
          source={{ uri: cover }}
          style={{ width: 72, height: 72, borderRadius: 8 }}
          contentFit="cover"
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </Pressable>
  );
});
