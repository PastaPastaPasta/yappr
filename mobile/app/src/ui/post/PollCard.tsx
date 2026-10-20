import { Pressable, View } from 'react-native';
import { ChartBarIcon } from 'react-native-heroicons/outline';
import { CheckCircleIcon } from 'react-native-heroicons/solid';

import { cn, formatNumber } from '~/lib-allowlist';

import { Button } from '../Button';
import { Skeleton, SkeletonGroup } from '../Skeleton';
import { Text } from '../Text';
import { tw, useColors } from '../tokens';
import { EMBED_FRAME } from './embed-frame';
import { pickOption, pollBallot, pollEndLabel, pollPercents, pollVotesLabel, usePollNow, usePollSelection } from './poll-ballot';
import type { CardPoll, Loadable } from './types';

const FRAME = cn(EMBED_FRAME, 'p-3');

export interface PollCardProps {
  poll: Loadable<CardPoll>;
  /** Send the ballot: the option indexes picked, none to withdraw it (`voting: 'editable'`). */
  onVotePress?: (choices: number[]) => void;
}

/**
 * A Pollr poll in a post (UX_SPEC §2.4.8, web poll-card.tsx): the results,
 * and while it is open the viewer's ballot. Tapping options picks them (one,
 * or several on a multiple-choice poll); "Vote" sends them, and on an
 * editable poll "Change vote" and "Withdraw" change it until the close. A
 * closed poll, a final ballot, or one that could not be read shows results
 * only, with the viewer's choices marked.
 */
export function PollCard({ poll, onVotePress }: PollCardProps) {
  const ready = poll === 'loading' || poll === 'error' ? null : poll;
  const now = usePollNow(ready?.endsAt ?? null);
  // Shared with the post's screen-reader actions (`usePollSelection`); a ballot read or saved since resets it.
  const [selected, setSelected] = usePollSelection(ready);

  if (!ready) return <PollPlaceholder state={poll === 'loading' ? 'loading' : 'error'} />;

  const percents = pollPercents(ready);
  const leading = Math.max(...ready.options.map((o) => o.votes));
  // Signed out (`myVotes` absent) the ballot is open too: sending it asks to sign in.
  const { canVote, multi, saving, voted, marked, unchanged, voteLabel } = pollBallot(ready, selected, now, onVotePress !== undefined);
  let role: 'radio' | 'checkbox' | null = null;
  if (canVote) role = multi ? 'checkbox' : 'radio';
  const pick = (i: number) => setSelected(pickOption(selected, i, multi));

  const votes = pollVotesLabel(ready.totalVotes, formatNumber);
  const status = !canVote && voted ? 'You voted' : null;

  return (
    <View className={FRAME} testID="poll">
      <Text variant="bodyStrong">{ready.question}</Text>
      {canVote && multi ? (
        <Text variant="caption" tone="secondary" className="mt-1">
          Choose one or more
        </Text>
      ) : null}
      <View className="mt-3 gap-2" accessibilityRole={canVote && !multi ? 'radiogroup' : undefined}>
        {ready.options.map((option, i) => (
          <PollOption
            key={i}
            label={option.label}
            percent={percents[i] ?? 0}
            lead={ready.totalVotes > 0 && option.votes === leading}
            picked={marked.includes(i)}
            role={role}
            disabled={saving}
            onPress={() => pick(i)}
            testID={`poll-option-${i}`}
          />
        ))}
      </View>
      <View className="mt-2 flex-row flex-wrap items-center justify-between gap-2">
        <Text variant="caption" tone="secondary" testID="poll-status">
          {[votes, pollEndLabel(ready.endsAt, now), status].filter(Boolean).join(' · ')}
        </Text>
        {canVote ? (
          <View className="flex-row items-center gap-2">
            {voted && ready.voting === 'editable' ? (
              <Button
                label="Withdraw"
                size="sm"
                variant="ghost"
                disabled={saving}
                onPress={() => onVotePress?.([])}
                testID="poll-withdraw"
              />
            ) : null}
            <Button
              label={voteLabel}
              size="sm"
              loading={saving}
              disabled={saving || selected.length === 0 || unchanged}
              onPress={() => onVotePress?.(selected)}
              testID="poll-vote"
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function PollPlaceholder({ state }: { state: 'loading' | 'error' }) {
  const c = useColors();
  if (state === 'loading') {
    return (
      <SkeletonGroup label="Loading poll" className={cn(FRAME, 'gap-2')} testID="poll-skeleton">
        <Skeleton width="66%" height={16} />
        <Skeleton height={32} className="rounded-lg" />
        <Skeleton height={32} className="rounded-lg" />
      </SkeletonGroup>
    );
  }
  return (
    <View className={cn(FRAME, 'flex-row items-center gap-2')} testID="poll-error">
      <ChartBarIcon size={16} color={c.textSecondary} />
      <Text variant="subhead" tone="secondary">
        Poll unavailable
      </Text>
    </View>
  );
}

/** One option: its share as a bar, and a check on the viewer's pick. Tappable only while the ballot is open (`role`). */
function PollOption({
  label,
  percent,
  lead,
  picked,
  role,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  percent: number;
  lead: boolean;
  picked: boolean;
  role: 'radio' | 'checkbox' | null;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  const c = useColors();
  const body = (
    <>
      <View
        className={cn('absolute bottom-0 left-0 top-0', lead ? 'bg-yappr-500/30' : 'bg-yappr-200 dark:bg-yappr-900')}
        style={{ width: `${percent}%` }}
      />
      <View className="min-h-11 flex-row items-center justify-between gap-3 px-3 py-2">
        <View className="shrink flex-row items-center gap-2">
          {picked ? <CheckCircleIcon size={18} color={c.accent} /> : null}
          <Text variant="subhead" className={cn('shrink', (lead || picked) && 'font-semibold')}>
            {label}
          </Text>
        </View>
        <Text variant="subhead" tone="secondary" tabular>
          {percent}%
        </Text>
      </View>
    </>
  );
  const frame = cn('overflow-hidden rounded-lg border', picked ? 'border-yappr-500' : tw.border);
  const spoken = `${label}, ${percent} percent`;
  if (!role) {
    return (
      <View accessible accessibilityLabel={picked ? `${spoken}, your vote` : spoken} className={frame} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={spoken}
      accessibilityState={{ checked: picked, disabled }}
      disabled={disabled}
      onPress={onPress}
      className={cn(frame, tw.pressed)}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}
