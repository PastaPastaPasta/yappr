import type { BlogDTO, BlogPostSummaryDTO } from '@engine/api';
import { router, Stack } from 'expo-router';
import { memo, useMemo } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { DocumentTextIcon, TrashIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { queryKeys } from '~/data/keys';
import { useEngineInfiniteQuery, useEngineQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { sendWrite } from '~/data/writes';
import { errorMessage } from '~/engine/logs';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { confirmAlert } from '~/ui/Dialog';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { ModerationLabel } from '~/ui/post/ModerationLabel';
import { Text } from '~/ui/Text';
import { tw } from '~/ui/tokens';

import { openBlog, openBlogPost } from './blog-navigation';
import { deletePostWrite } from './blog-writes';

type Row =
  | { kind: 'blog'; blog: BlogDTO }
  | { kind: 'heading' }
  | { kind: 'post'; post: BlogPostSummaryDTO };

const rowKey = (row: Row) => (row.kind === 'blog' ? `blog:${row.blog.id}` : row.kind === 'post' ? `post:${row.post.id}` : 'heading');

const shortDate = (date: Date) =>
  new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function newBlog(): void {
  router.push('/blogs/new');
}

const BlogRow = memo(function BlogRow({ blog }: { blog: BlogDTO }) {
  return (
    <View className={cn('gap-2 border-b px-4 py-3', tw.border)} testID={`manage-blog-${blog.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[blog.name, blog.description].filter(Boolean).join(', ')}
        onPress={() => openBlog(blog.id)}
        testID={`manage-blog-open-${blog.id}`}
        className={cn('min-h-12 flex-row items-center gap-3', tw.pressed)}
      >
        <Avatar
          uri={blog.avatar ?? undefined}
          avatar={blog.avatar ? undefined : (blog.owner?.avatar ?? undefined)}
          identityId={blog.ownerId}
          size="lg"
        />
        <View className="flex-1 gap-0.5">
          <Text variant="bodyStrong" numberOfLines={1}>
            {blog.name}
          </Text>
          {blog.description ? (
            <Text variant="subhead" tone="secondary" numberOfLines={1}>
              {blog.description}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {/* Blog v10: the author's own hidden blog is listed here, labelled (it is not listed anywhere else). */}
      <ModerationLabel moderation={blog.moderation} testID={`manage-blog-moderation-${blog.id}`} />
      <View className="flex-row items-center gap-2">
        <Button
          label="Write"
          variant="outline"
          size="sm"
          onPress={() => router.push({ pathname: '/blog/[id]/write', params: { id: blog.id } })}
          testID={`manage-blog-write-${blog.id}`}
        />
        <Button
          label="Settings"
          variant="link"
          size="sm"
          onPress={() => router.push({ pathname: '/blog/[id]/settings', params: { id: blog.id } })}
          testID={`manage-blog-settings-${blog.id}`}
        />
      </View>
    </View>
  );
});

const PostRow = memo(function PostRow({ post }: { post: BlogPostSummaryDTO }) {
  const blogName = post.blogName;
  const askDelete = () => {
    confirmAlert({
      title: 'Delete this post?',
      message: 'It will be removed from your blog. This can’t be undone.',
      confirmText: 'Delete',
      destructive: true,
    })
      .then((confirmed) => {
        if (confirmed) sendWrite(deletePostWrite, { postId: post.id, blogId: post.blogId }, 'Post deleted');
      })
      .catch(() => undefined);
  };
  const subtitle = `${blogName ?? 'Blog deleted'} · ${post.publishedAt ? shortDate(post.publishedAt) : 'Draft'}`;
  return (
    <View className={cn('min-h-14 flex-row items-center gap-2 border-b pl-4 pr-2 py-2', tw.border)} testID={`manage-post-${post.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${post.title}, ${subtitle}`}
        disabled={blogName === null}
        onPress={() => openBlogPost(post.blogId, post.slug)}
        testID={`manage-post-open-${post.id}`}
        className={cn('min-h-12 flex-1 justify-center gap-0.5', tw.pressed)}
      >
        <Text variant="bodyStrong" numberOfLines={2}>
          {post.title}
        </Text>
        <Text variant="subhead" tone="secondary" numberOfLines={1}>
          {subtitle}
        </Text>
        {/* Blog v10: hidden, or written while restricted, so not listed in discovery. */}
        <ModerationLabel moderation={post.moderation} testID={`manage-post-moderation-${post.id}`} />
      </Pressable>
      <IconButton
        icon={TrashIcon}
        variant="danger"
        accessibilityLabel="Delete post"
        onPress={askDelete}
        testID={`manage-post-delete-${post.id}`}
      />
    </View>
  );
});

/** Your blogs (`/blogs/mine`): the viewer's blogs with Write and Settings, and their posts across blogs. */
export function ManageBlogsScreen() {
  const { status, identityId } = useSession();
  const signedIn = status === 'signed-in' && identityId !== null;
  const info = useEngineQuery(queryKeys.blog.info, (api) => api.blogs.info());
  const mine = useEngineQuery(queryKeys.blog.mine, (api) => api.blogs.mine(), { enabled: signedIn });
  const ownerPosts = info.data?.ownerPosts === true;
  const posts = useEngineInfiniteQuery(queryKeys.blog.myPosts, (api, cursor) => api.blogs.myPosts(cursor), {
    enabled: signedIn && ownerPosts,
  });

  const blogs = mine.data;
  const postItems = posts.items;
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = (blogs ?? []).map((blog) => ({ kind: 'blog', blog }));
    if (ownerPosts && postItems.length > 0) {
      list.push({ kind: 'heading' });
      for (const post of postItems) list.push({ kind: 'post', post });
    }
    return list;
  }, [blogs, ownerPosts, postItems]);

  let empty;
  if (!signedIn) {
    empty =
      status === 'unknown' ? (
        <View className="items-center p-8">
          <Spinner />
        </View>
      ) : (
        <EmptyState
          title="Sign in to manage your blogs"
          icon={DocumentTextIcon}
          action={{ label: 'Sign in', onPress: () => router.push('/sign-in') }}
          testID="manage-blogs-signed-out"
        />
      );
  } else if (mine.isPending) {
    empty = (
      <View className="items-center p-8" testID="manage-blogs-loading">
        <Spinner />
      </View>
    );
  } else if (mine.isError) {
    empty = (
      <ErrorState
        message={errorMessage(mine.error)}
        onRetry={() => {
          mine.refetch().catch(() => undefined);
        }}
        retrying={mine.isRetrying}
        testID="manage-blogs-error"
      />
    );
  } else {
    empty = (
      <EmptyState
        title="No blogs yet"
        description="Start a blog to share longer posts."
        icon={DocumentTextIcon}
        action={{ label: 'New blog', onPress: newBlog }}
        testID="manage-blogs-empty"
      />
    );
  }

  const header =
    signedIn && rows.length > 0 ? (
      <View className="px-4 py-3">
        <Button label="New blog" size="block" onPress={newBlog} testID="manage-blogs-new" />
      </View>
    ) : null;

  const footer = (
    <>
      {posts.isFetchingNextPage ? (
        <View className="items-center p-6">
          <Spinner size="sm" />
        </View>
      ) : posts.hasNextPage ? (
        <View className="items-center p-6">
          <Button
            label="Load more"
            variant="outline"
            size="sm"
            onPress={() => {
              posts.fetchNextPage().catch(() => undefined);
            }}
            testID="manage-posts-more"
          />
        </View>
      ) : null}
      {signedIn && ownerPosts && posts.isError && !posts.isFetchingNextPage && postItems.length === 0 ? (
        <View className="items-center gap-3 p-6" testID="manage-posts-error">
          <Text variant="subhead" tone="secondary">
            {"Couldn't load your posts."}
          </Text>
          <Button
            label="Try again"
            variant="outline"
            size="sm"
            onPress={() => {
              posts.refetch().catch(() => undefined);
            }}
          />
        </View>
      ) : null}
    </>
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Your blogs' }} />
      <FlatList
        data={rows}
        keyExtractor={rowKey}
        renderItem={({ item }) => {
          if (item.kind === 'blog') return <BlogRow blog={item.blog} />;
          if (item.kind === 'post') return <PostRow post={item.post} />;
          return (
            <Text variant="headline" tone="emphasis" accessibilityRole="header" className="px-4 pb-2 pt-6">
              Your posts
            </Text>
          );
        }}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        testID="manage-blogs-list"
      />
    </Screen>
  );
}
