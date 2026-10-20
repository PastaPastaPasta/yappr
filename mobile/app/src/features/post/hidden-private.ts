import type { PostDTO } from '@engine/api';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

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

/** The setting: browsing lists (feeds, Explore, tag pages, search) leave unreadable private posts out. */
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

/** A private post the viewer can't open: someone else's, still encrypted. */
export const isUnreadablePrivate = (post: PostDTO, viewerId: string | null) =>
  post.encrypted && !post.deleted && post.author.id !== viewerId;
