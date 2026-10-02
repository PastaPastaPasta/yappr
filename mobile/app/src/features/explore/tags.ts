import type { RankingWindow, TagDTO } from '@engine/api';

import {
  cashtagDisplayToStorage,
  cashtagStorageToDisplay,
  formatNumber,
  hashtagDisplayToStorage,
  isCashtagStorage,
} from '~/lib-allowlist';
import type { TabOption } from '~/ui/Tabs';

/** A hashtag or cashtag as the hashtag page needs it. */
export interface TagRef {
  /** Storage form: `dash`, or `dash_cashtag` for `$DASH`. Empty when the param is not a tag. */
  storage: string;
  /** `#dash` or `$DASH`. */
  display: string;
}

/** The contract's tag pattern (storage form). */
const STORAGE_TAG = /^[a-z0-9_]{1,63}$/;

/**
 * The hashtag route's `tag` param, in any form a link carries: storage
 * (`dash`, `dash_cashtag`, from post cards and trending), display (`#Dash`,
 * `$DASH`, from `/hashtag?tag=$dash` links). Anything else is no tag.
 */
export function tagFromParam(param: string | undefined): TagRef {
  const raw = (param ?? '').trim();
  const storage = raw.startsWith('$') ? cashtagDisplayToStorage(raw) : hashtagDisplayToStorage(raw);
  if (!STORAGE_TAG.test(storage) || storage === '_cashtag') return { storage: '', display: '' };
  return { storage, display: tagDisplay(storage) };
}

/** `#dash` or `$DASH` for a storage-form tag. */
export function tagDisplay(storage: string): string {
  return isCashtagStorage(storage) ? `$${cashtagStorageToDisplay(storage)}` : `#${storage}`;
}

/** "1 post", "12 posts", "1.2K likes" (web `formatNumber` with the singular). */
export function countLabel(count: number, noun: 'post' | 'like' | 'follower'): string {
  return `${formatNumber(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** A trending or search row's secondary line: likes where the contract ranks them, else posts (UX_SPEC §4.15). */
export const tagCountLabel = (tag: TagDTO) => countLabel(tag.count, tag.countKind === 'likes' ? 'like' : 'post');

/**
 * Each ranked axis's own window on the dev cut (web `windowedRankingFor`):
 * trending tags and a tag's Top read the 24 h hashtag axis, Top posts the
 * 3-day post axis. Creators have no window.
 */
export const TAG_WINDOWS: readonly TabOption<RankingWindow>[] = [
  { value: 'today', label: '24h' },
  { value: 'all', label: 'All time' },
];

export const POST_WINDOWS: readonly TabOption<RankingWindow>[] = [
  { value: 'today', label: '3 days' },
  { value: 'all', label: 'All time' },
];
