import type { ContentCreatedEvent } from '@engine/api';

import { queryClient } from '~/state/query-client';

import { onEngineEvent } from './events';
import { queryKeys } from './keys';
import { useRemovedPosts } from './optimistic';
import { startSessionSync, useSessionStore } from './session';
import { resetWriteTracking, startWriteTracking } from './writes';

/**
 * A post or reply this device published: seed its detail and refetch what
 * now holds it (feeds, the author's profile, the thread and quoted post it
 * belongs to).
 */
function contentCreated({ post }: ContentCreatedEvent): void {
  queryClient.setQueryData(queryKeys.post.detail(post.id), post);
  const stale = [
    queryKeys.feed.all,
    queryKeys.profile.detail(post.author.id),
    ...[post.parentId, post.rootPostId, post.quotedPostId].flatMap((id) => (id ? [queryKeys.post.detail(id)] : [])),
  ];
  for (const queryKey of stale) {
    queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
  }
}

/**
 * The app-wide engine subscriptions: the session store, write tickets and
 * created content. The root layout starts it once; returns the stop.
 */
export function startDataLayer(): () => void {
  // Another account's writes and deletes mean nothing to the next one.
  const stopAccount = useSessionStore.subscribe((state, previous) => {
    if (previous.status !== 'unknown' && state.session?.identityId !== previous.session?.identityId) {
      resetWriteTracking();
      useRemovedPosts.setState({ ids: new Set() });
    }
  });
  const stops = [
    startSessionSync(),
    startWriteTracking(),
    onEngineEvent('content.created', contentCreated),
    stopAccount,
  ];
  return () => stops.forEach((stop) => stop());
}
