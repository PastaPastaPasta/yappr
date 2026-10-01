import { View } from 'react-native';
import { ChartBarIcon } from 'react-native-heroicons/outline';

import { cn, formatNumber } from '~/lib-allowlist';

import { LinkText } from '../LinkText';
import { Skeleton, SkeletonGroup } from '../Skeleton';
import { Text } from '../Text';
import { tw, useColors } from '../tokens';
import { EMBED_FRAME } from './embed-frame';
import type { CardPoll, Loadable } from './types';

const FRAME = cn(EMBED_FRAME, 'p-3');

/** "Ends in 2d" / "Ended" / "No end date" (UX_SPEC §5.3). */
export function pollEndLabel(endsAt: Date | null, now = Date.now()): string {
  if (!endsAt) return 'No end date';
  const left = endsAt.getTime() - now;
  if (left <= 0) return 'Ended';
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Ends in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Ends in ${hours}h`;
  return `Ends in ${Math.floor(hours / 24)}d`;
}

/** Whole-number shares that are 0 for an empty poll. */
export function pollPercents(poll: CardPoll): number[] {
  return poll.options.map((o) => (poll.totalVotes > 0 ? Math.round((o.votes / poll.totalVotes) * 100) : 0));
}

export interface PollCardProps {
  poll: Loadable<CardPoll>;
  /** Voting happens on web in 1.0. */
  onVotePress?: () => void;
}

/** A read-only Pollr poll in a post (UX_SPEC §2.4.8, web poll-card.tsx results view). */
export function PollCard({ poll, onVotePress }: PollCardProps) {
  const c = useColors();

  if (poll === 'loading') {
    return (
      <SkeletonGroup label="Loading poll" className={cn(FRAME, 'gap-2')} testID="poll-skeleton">
        <Skeleton width="66%" height={16} />
        <Skeleton height={32} className="rounded-lg" />
        <Skeleton height={32} className="rounded-lg" />
      </SkeletonGroup>
    );
  }
  if (poll === 'error') {
    return (
      <View className={cn(FRAME, 'flex-row items-center gap-2')} testID="poll-error">
        <ChartBarIcon size={16} color={c.textSecondary} />
        <Text variant="subhead" tone="secondary">
          Poll unavailable
        </Text>
      </View>
    );
  }

  const percents = pollPercents(poll);
  const leading = Math.max(...poll.options.map((o) => o.votes));
  const end = pollEndLabel(poll.endsAt);
  const votes = `${formatNumber(poll.totalVotes)} ${poll.totalVotes === 1 ? 'vote' : 'votes'}`;

  return (
    <View className={FRAME} testID="poll">
      <Text variant="bodyStrong">{poll.question}</Text>
      <View className="mt-3 gap-2">
        {poll.options.map((option, i) => {
          const lead = poll.totalVotes > 0 && option.votes === leading;
          return (
            <View
              key={i}
              accessible
              accessibilityLabel={`${option.label}, ${percents[i]}%`}
              className={cn('overflow-hidden rounded-lg border', tw.border)}
            >
              <View
                className={cn(
                  'absolute bottom-0 left-0 top-0',
                  lead ? 'bg-yappr-500/30' : 'bg-yappr-200 dark:bg-yappr-900',
                )}
                style={{ width: `${percents[i]}%` }}
              />
              <View className="flex-row items-center justify-between gap-3 px-3 py-2">
                <Text variant="subhead" className={cn('shrink', lead && 'font-semibold')}>
                  {option.label}
                </Text>
                <Text variant="subhead" tone="secondary" tabular>
                  {percents[i]}%
                </Text>
              </View>
            </View>
          );
        })}
      </View>
      <View className="mt-2 flex-row flex-wrap items-center justify-between gap-2">
        <Text variant="caption" tone="secondary">
          {votes} · {end}
        </Text>
        <LinkText label="Vote on yap.pr" variant="captionStrong" onPress={onVotePress} />
      </View>
    </View>
  );
}
