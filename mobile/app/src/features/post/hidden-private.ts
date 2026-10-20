import type { PostDTO } from '@engine/api';
import { useMemo } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { useProvisionalViewerId } from '~/data/session';
import { syncStorage } from '~/state/storage';
import { selectionTick } from '~/ui/haptics';
import { toast } from '~/ui/toast';

/** The setting's name, in the post menu and in Privacy & Safety (owner finding #4's wording). */
export const HIDE_PRIVATE_LABEL = "Hide private posts I can't see";

interface HiddenPrivate {
  /** Leave private posts the viewer can't read out of lists. Device-wide, like the content settings. */
  hide: boolean;
}

export const useHiddenPrivateStore = create<HiddenPrivate>()(
  persist((): HiddenPrivate => ({ hide: false }), {
    name: 'yappr.hidden-private',
    version: 1,
    storage: createJSONStorage(() => syncStorage),
    merge: (persisted, current) => ({ ...current, hide: (persisted as Partial<HiddenPrivate> | undefined)?.hide === true }),
  }),
);

/** The setting. */
export const useHideUnreadablePrivate = () => useHiddenPrivateStore((s) => s.hide);

export function setHidePrivate(hide: boolean): void {
  selectionTick();
  useHiddenPrivateStore.setState({ hide });
}

/** From the post menu: hide them now, with Undo (Settings → Privacy & Safety turns it off later). */
export function hidePrivateFromMenu(): void {
  setHidePrivate(true);
  toast("Hidden private posts you can't see", { action: { label: 'Undo', onPress: () => setHidePrivate(false) } });
}

/**
 * A private post the viewer can't open: someone else's, still encrypted. A
 * bare repost is judged by the post it reposts. (Mobile decrypts nothing yet;
 * once private feeds open in the app, this asks whether this one opened.)
 */
export function isUnreadablePrivate(post: PostDTO, viewerId: string | null): boolean {
  const shown = post.bareRepost && post.quoted ? post.quoted : post;
  return shown.encrypted && !shown.deleted && shown.author.id !== viewerId;
}

/**
 * A feed's posts as the setting shows them (Home, Explore Top, tag pages).
 * Filtered before the list, so its empty state and the new-posts count see
 * what is shown. Threads, profiles, bookmarks and search keep every post.
 * The provisional viewer, so the account's own posts don't blink at launch.
 */
export function useFeedPosts<T extends PostDTO>(posts: readonly T[]): readonly T[] {
  const hide = useHideUnreadablePrivate();
  const viewerId = useProvisionalViewerId();
  return useMemo(() => (hide ? posts.filter((post) => !isUnreadablePrivate(post, viewerId)) : posts), [hide, posts, viewerId]);
}
