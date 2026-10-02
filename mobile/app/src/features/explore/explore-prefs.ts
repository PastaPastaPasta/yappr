import type { CapabilitiesDTO, RankingWindow } from '@engine/api';
import { create } from 'zustand';

import type { TabOption } from '~/ui/Tabs';

export type ExploreSegment = 'trending' | 'top' | 'creators';

/**
 * The Explore segment and each ranked list's window, remembered for the
 * session only (PRD EXPL-01). Trending opens on the 24h window, as the PRD's
 * "likes in the last 24h" (EXPL-02); Top posts on All time, as web.
 */
export const useExplorePrefs = create<{
  segment: ExploreSegment;
  trendingWindow: RankingWindow;
  topWindow: RankingWindow;
}>()(() => ({ segment: 'trending', trendingWindow: 'today', topWindow: 'all' }));

/** The segments this contract can serve: Top needs the like rankings, Creators the prefix rankings. */
export function exploreSegments(capabilities: CapabilitiesDTO | null): TabOption<ExploreSegment>[] {
  const segments: TabOption<ExploreSegment>[] = [{ value: 'trending', label: 'Trending' }];
  if (capabilities?.rankings) segments.push({ value: 'top', label: 'Top' });
  if (capabilities?.prefixRankings) segments.push({ value: 'creators', label: 'Creators' });
  return segments;
}

/** The remembered segment, or Trending where the contract can't serve it. */
export function shownSegment(remembered: ExploreSegment, segments: readonly TabOption<ExploreSegment>[]): ExploreSegment {
  return segments.some((s) => s.value === remembered) ? remembered : 'trending';
}
