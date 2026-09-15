'use client';

import { RankingWindowToggle } from '@/components/explore/ranking-window-toggle';
import type { RankingWindow } from '@/lib/services/ranked-likes';

export type FeedSortMode = 'recent' | 'top';

interface FeedSortToggleProps {
  sortMode: FeedSortMode;
  onSortModeChange: (mode: FeedSortMode) => void;
  rankingWindow: RankingWindow;
  onRankingWindowChange: (window: RankingWindow) => void;
}

/**
 * Recent | Top for the home feed, mirroring the hashtag page's Latest | Top
 * pills. Top rides the v4+ ranked like axes, so callers only mount this when
 * `likesAreIndexOnly()`. The Today | All time window switch appears under Top
 * on v6 topologies (`RankingWindowToggle` renders nothing elsewhere).
 */
export function FeedSortToggle({ sortMode, onSortModeChange, rankingWindow, onRankingWindowChange }: FeedSortToggleProps) {
  const option = (mode: FeedSortMode, label: string) => (
    <button
      onClick={() => onSortModeChange(mode)}
      data-testid={`feed-sort-${mode}`}
      aria-pressed={sortMode === mode}
      className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
        sortMode === mode
          ? 'bg-yappr-500 text-white'
          : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      <div className="flex gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-800">
        {option('recent', 'Recent')}
        {option('top', 'Top')}
      </div>
      {sortMode === 'top' && (
        <RankingWindowToggle value={rankingWindow} onChange={onRankingWindowChange} testIdPrefix="feed-top" />
      )}
    </>
  );
}
