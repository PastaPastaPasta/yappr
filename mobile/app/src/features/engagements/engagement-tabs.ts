import type { EngagementCountsDTO } from '@engine/api/dto';
import type { EngagementTab } from '@engine/api/posts';

import { formatNumber } from '~/lib-allowlist';

/** The tabs in their order (UX_SPEC §4.10); Reposts only where the kind can be reposted. */
export function engagementTabs(repostable: boolean): EngagementTab[] {
  return repostable ? ['quotes', 'reposts', 'likes'] : ['quotes', 'likes'];
}

/** `?tab=` when it names a tab this post has, else Likes (web's default). */
export function initialTab(requested: string | undefined, tabs: readonly EngagementTab[]): EngagementTab {
  return tabs.find((tab) => tab === requested) ?? 'likes';
}

const NAMES: Record<EngagementTab, string> = { quotes: 'Quotes', reposts: 'Reposts', likes: 'Likes' };

/**
 * "Likes (48)", or the bare name while the count is unknown or zero. On v10
 * reposts and quotes are split off one 100-document quote list; once that
 * list fills up their counts are floors: "Reposts (100+)", "Quotes (12+)".
 */
export function tabLabel(tab: EngagementTab, counts: EngagementCountsDTO | undefined): string {
  const name = NAMES[tab];
  if (!counts) return name;
  const n = counts[tab];
  if (n <= 0) return name;
  const floor = counts.truncated && tab !== 'likes' ? '+' : '';
  return `${name} (${formatNumber(n)}${floor})`;
}

/** Each tab's empty state (UX_SPEC §5.3). */
export const EMPTY_COPY: Record<EngagementTab, { title: string; description: string }> = {
  quotes: { title: 'No quotes yet', description: "When people quote this post, they'll appear here." },
  reposts: { title: 'No reposts yet', description: "When people repost this post, they'll appear here." },
  likes: { title: 'No likes yet', description: "When people like this post, they'll appear here." },
};
