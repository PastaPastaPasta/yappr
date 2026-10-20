import { router } from 'expo-router';
import { Platform, Share } from 'react-native';

import { config } from '~/config';
import { webUrl } from '~/navigation/web-urls';
import { appendLog, errorMessage } from '~/engine/logs';

/**
 * Blog screens open on the current tab's stack, as posts and profiles do
 * (`(tabs)/(home,explore,notifications,messages,profile)/blog*`).
 */

export function openBlogs(): void {
  router.push('/blogs');
}

export function openBlog(blogId: string): void {
  router.push({ pathname: '/blog/[id]', params: { id: blogId } });
}

export function openBlogPost(blogId: string, slug: string): void {
  router.push({ pathname: '/blog/[id]/post/[slug]', params: { id: blogId, slug } });
}

/** A blog's page on yap.pr (`getBlogUrl`). */
export const blogWebUrl = (blogId: string) => webUrl(config, '/blog', { blog: blogId });

/** A post's page on yap.pr (`getBlogPostUrl`). */
export const blogPostWebUrl = (blogId: string, slug: string) => webUrl(config, '/blog', { blog: blogId, post: slug });

/** The native share sheet with a yap.pr link. */
export function shareLink(url: string, title: string): void {
  const content = Platform.OS === 'ios' ? { url, message: title } : { message: `${title}\n${url}`, title };
  Share.share(content).catch((error: unknown) => appendLog('warn', 'host', `Share failed: ${errorMessage(error)}`));
}
