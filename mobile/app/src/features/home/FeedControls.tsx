import type { RankingWindow } from '@engine/api';
import type { FeedTab } from '@engine/api/feed';
import { View } from 'react-native';
import { SignalSlashIcon } from 'react-native-heroicons/outline';

import { cn } from '~/lib-allowlist';
import { SegmentedControl, TopTabs, type TabOption } from '~/ui/Tabs';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

import type { FeedSort } from './home-prefs';

/** Web order (UX_SPEC §5.2). */
const TABS: readonly TabOption<FeedTab>[] = [
  { value: 'forYou', label: 'For You' },
  { value: 'following', label: 'Following' },
];

const SORTS: readonly TabOption<FeedSort>[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'top', label: 'Top' },
];

/** The posts axis's window on the dev cut (`windowedRankingFor('posts')`: "3 days"). */
const WINDOWS: readonly TabOption<RankingWindow>[] = [
  { value: 'today', label: '3 days' },
  { value: 'all', label: 'All time' },
];

export interface FeedControlsProps {
  tab: FeedTab;
  onTab: (tab: FeedTab) => void;
  sort: FeedSort;
  onSort: (sort: FeedSort) => void;
  window: RankingWindow;
  onWindow: (window: RankingWindow) => void;
  /** `capabilities.rankings`: Recent / Top exists at all (PRD FEED-04, absent on v2). */
  showSort: boolean;
  /** The window control under Top, where this tab's ranking has a window. */
  showWindow: boolean;
}

/** For You / Following, then Recent / Top and the window where the contract ranks likes. */
export function FeedControls({
  tab,
  onTab,
  sort,
  onSort,
  window,
  onWindow,
  showSort,
  showWindow,
}: FeedControlsProps) {
  return (
    <View className={tw.bg}>
      <TopTabs options={TABS} value={tab} onChange={onTab} testID="home-tabs" />
      {showSort ? (
        <View className={cn('flex-row items-center gap-3 border-b px-4 py-2', tw.border)}>
          <View className="flex-1">
            <SegmentedControl options={SORTS} value={sort} onChange={onSort} testID="home-sort" />
          </View>
          {showWindow ? (
            <View className="flex-1">
              <SegmentedControl options={WINDOWS} value={window} onChange={onWindow} testID="home-window" />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** UX_SPEC §2.18: pushes the content down, never overlays it. */
export function OfflineBanner() {
  const c = useColors();
  return (
    <View
      accessibilityRole="alert"
      testID="offline-banner"
      className={cn('min-h-9 flex-row items-center justify-center gap-2 px-4 py-2', tw.offlineBg)}
    >
      <SignalSlashIcon size={16} color={c.textPrimary} />
      <Text variant="subhead">You&apos;re offline. Showing saved posts.</Text>
    </View>
  );
}
