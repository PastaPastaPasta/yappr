import type { PostDTO } from '@engine/api';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Platform, Share } from 'react-native';

import { config } from '~/config';
import { queryKeys } from '~/data/keys';
import { appendLog, errorMessage } from '~/engine/logs';
import { queryClient } from '~/state/query-client';
import { selectionTick } from '~/ui/haptics';
import { toast } from '~/ui/toast';

/**
 * Where a post's links go. Detail routes push onto the current tab's stack
 * (UX_SPEC §3.2); web links use this variant's yap.pr prefix.
 */

/**
 * The post on yap.pr (devnet: under `/devnet`): `/post?id=<id>`, and for a
 * reply `/post?id=<root>&reply=<id>`, its thread with it highlighted (PRD ENG-05).
 */
export function postWebUrl(post: Pick<PostDTO, 'id' | 'kind' | 'rootPostId'> | string): string {
  const base = `https://yap.pr${config.webBasePath}/post?id=`;
  if (typeof post === 'string') return base + encodeURIComponent(post);
  return post.kind === 'reply' && post.rootPostId
    ? `${base}${encodeURIComponent(post.rootPostId)}&reply=${encodeURIComponent(post.id)}`
    : base + encodeURIComponent(post.id);
}

/** Opens a post. The card's data seeds the detail screen, which refetches at once. */
export function openPost(post: PostDTO | string): void {
  const id = typeof post === 'string' ? post : post.id;
  // A cached `null` may be a failed read (lib answers one as "absent"): the card proves the post exists.
  if (typeof post !== 'string' && queryClient.getQueryData(queryKeys.post.detail(id)) == null) {
    // A bare repost's card shows its target under the reposter's banner; the detail is the target alone.
    const { repostedBy: _banner, repostTimestamp: _at, ...detail } = post;
    queryClient.setQueryData(queryKeys.post.detail(id), detail, { updatedAt: 0 });
  }
  router.push({ pathname: '/post/[id]', params: { id } });
}

/** A profile by identity id or DPNS name (`profiles.get` takes either). */
export function openUser(idOrName: string): void {
  router.push({ pathname: '/user/[id]', params: { id: idOrName } });
}

/** A hashtag or cashtag page, by its storage form (`dash`, `dash_cashtag`). */
export function openHashtag(tag: string): void {
  router.push({ pathname: '/hashtag/[tag]', params: { tag } });
}

/** An external link, already through `safeExternalUrl`, in the in-app browser. */
export function openExternal(url: string | null): void {
  if (!url) return;
  WebBrowser.openBrowserAsync(url).catch((error: unknown) => {
    appendLog('warn', 'host', `Opening a link failed: ${errorMessage(error)}`);
    toast.error("Couldn't open the link");
  });
}

/** The native share sheet with the post's yap.pr link and "{name} on Yappr" (PRD ENG-05). */
export function sharePost(post: PostDTO): void {
  const url = postWebUrl(post);
  const text = `${post.author.displayName} on Yappr`;
  const content = Platform.OS === 'ios' ? { url, message: text } : { message: `${text}\n${url}`, title: text };
  Share.share(content).catch((error: unknown) => appendLog('warn', 'host', `Share failed: ${errorMessage(error)}`));
}

export function copyText(text: string, confirmation: string): void {
  Clipboard.setStringAsync(text)
    .then(() => {
      selectionTick();
      toast.success(confirmation);
    })
    .catch(() => toast.error("Couldn't copy"));
}
