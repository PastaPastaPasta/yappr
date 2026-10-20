import { useCallback, useSyncExternalStore } from 'react';
import { create } from 'zustand';

import type { CardPoll } from './types';

const MINUTE_MS = 60_000;
/** How often an open poll's close is read again (its label counts in minutes at the finest). */
const TICK_MS = 30_000;

/** Whole minutes, hours or days left until the close, or null once it has passed. */
function timeLeft(endsAt: Date, now: number): { n: number; unit: 'minute' | 'hour' | 'day' } | null {
  const left = endsAt.getTime() - now;
  if (left <= 0) return null;
  const minutes = Math.ceil(left / MINUTE_MS);
  if (minutes < 60) return { n: minutes, unit: 'minute' };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { n: hours, unit: 'hour' };
  return { n: Math.floor(hours / 24), unit: 'day' };
}

const SHORT_UNIT = { minute: 'm', hour: 'h', day: 'd' } as const;

/** "Ends in 2d" / "Ended" / "No end date" (UX_SPEC §5.3). */
export function pollEndLabel(endsAt: Date | null, now = Date.now()): string {
  if (!endsAt) return 'No end date';
  const left = timeLeft(endsAt, now);
  return left ? `Ends in ${left.n}${SHORT_UNIT[left.unit]}` : 'Ended';
}

/** The screen-reader form, "Ends in 2 days" ("2d" would read as letters, "50m" as "50 meters"). */
export function pollEndSpoken(endsAt: Date | null, now = Date.now()): string {
  if (!endsAt) return 'No end date';
  const left = timeLeft(endsAt, now);
  return left ? `Ends in ${left.n} ${left.unit}${left.n === 1 ? '' : 's'}` : 'Ended';
}

export interface PollClock {
  closed: boolean;
  /** `pollEndLabel` */
  endLabel: string;
  /** `pollEndSpoken` */
  endSpoken: string;
}

/**
 * Where a poll's close stands now, kept current while it is open (every 30 s,
 * and at the close itself). Read from the clock as an external store, so a
 * list row reused for another poll reads that poll's close at once, and the
 * label is never computed from the time in the render body (React Compiler).
 */
export function usePollClock(endsAt: Date | null): PollClock {
  const endsMs = endsAt ? endsAt.getTime() : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (endsMs === null || endsMs <= Date.now()) return () => undefined;
      const tick = setInterval(listener, TICK_MS);
      const close = setTimeout(listener, endsMs - Date.now() + 50);
      return () => {
        clearInterval(tick);
        clearTimeout(close);
      };
    },
    [endsMs],
  );
  // One string, so the snapshot is stable between ticks that change nothing.
  const snapshot = useSyncExternalStore(subscribe, () => {
    const ends = endsMs === null ? null : new Date(endsMs);
    const now = Date.now();
    return [endsMs !== null && endsMs <= now ? '1' : '0', pollEndLabel(ends, now), pollEndSpoken(ends, now)].join('\u0000');
  });
  const [closed = '0', endLabel = '', endSpoken = ''] = snapshot.split('\u0000');
  return { closed: closed === '1', endLabel, endSpoken };
}

/** Whole-number shares that are 0 for an empty poll. */
export function pollPercents(poll: CardPoll): number[] {
  return poll.options.map((o) => (poll.totalVotes > 0 ? Math.round((o.votes / poll.totalVotes) * 100) : 0));
}

/** A ballot as one comparable string: its option indexes in order. */
export const ballotKey = (choices: readonly number[] | null | undefined) => (choices ? [...choices].sort((a, b) => a - b).join(',') : '');

/**
 * The options picked but not sent yet, per viewer and poll: the card shows
 * them and the post's screen-reader actions pick them (the card is one
 * element, UX_SPEC §6.2), so both share one selection. A ballot read or saved
 * since starts it over from the viewer's votes; a vote that failed and rolled
 * back finds the picks again, to try again.
 */
const useSelections = create<Record<string, { cast: string; selected: number[] }>>()(() => ({}));

/** Forgets every unsent pick (tests: each starts with none). */
export function clearPollSelections(): void {
  useSelections.setState({}, true);
}

/** `viewerId`: whose picks (another account, or signed out, never sends this one's). */
export function usePollSelection(poll: CardPoll | null, viewerId: string | undefined): [number[], (selected: number[]) => void] {
  const key = poll ? `${viewerId ?? ''}|${poll.id}` : '';
  const cast = ballotKey(poll?.myVotes);
  const entry = useSelections((s) => (key ? s[key] : undefined));
  const selected = entry && entry.cast === cast ? entry.selected : (poll?.myVotes ?? []);
  const select = (next: number[]) => {
    if (key) useSelections.setState({ [key]: { cast, selected: next } });
  };
  return [selected, select];
}

export interface PollBallot {
  /** The ballot is open to this viewer (signed out too: sending it asks to sign in). */
  canVote: boolean;
  multi: boolean;
  saving: boolean;
  /** The viewer has a ballot in. */
  voted: boolean;
  /** Shown with a check: the selection while voting, else the viewer's votes. */
  marked: number[];
  /** The selection is the ballot already in (nothing to send). */
  unchanged: boolean;
  voteLabel: 'Vote' | 'Change vote' | 'Saving…';
}

/** Where the viewer's ballot stands; `canSend` when the card can send one at all. */
export function pollBallot(poll: CardPoll, selected: number[], closed: boolean, canSend: boolean): PollBallot {
  const mine = poll.myVotes ?? [];
  const voted = mine.length > 0;
  const saving = poll.saving === true;
  const canVote = Boolean(poll.voting) && canSend && !closed && poll.myVotes !== null && !(poll.voting === 'once' && voted);
  let voteLabel: PollBallot['voteLabel'] = 'Vote';
  if (saving) voteLabel = 'Saving…';
  else if (voted) voteLabel = 'Change vote';
  return {
    canVote,
    multi: poll.multiChoice === true,
    saving,
    voted,
    marked: canVote ? selected : mine,
    unchanged: ballotKey(selected) === ballotKey(poll.myVotes),
    voteLabel,
  };
}

/** The selection after picking option `i`: one on a single-choice poll, toggled on a multiple-choice one. */
export function pickOption(selected: readonly number[], i: number, multi: boolean): number[] {
  if (!multi) return [i];
  return selected.includes(i) ? selected.filter((v) => v !== i) : [...selected, i];
}

/** "{n} vote(s)". */
export function pollVotesLabel(totalVotes: number, format: (n: number) => string): string {
  return `${format(totalVotes)} ${totalVotes === 1 ? 'vote' : 'votes'}`;
}

/** A sentence: a full stop unless it already ends one ("Which tab?" stays as it is). */
const sentence = (text: string) => (/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The poll for a screen reader (D-957): the question, each option with its
 * share and whether it is picked, and the count, the close and the ballot.
 */
export function pollSpokenLabel(poll: CardPoll, ballot: PollBallot, endSpoken: string, format: (n: number) => string): string {
  const percents = pollPercents(poll);
  const mine = poll.myVotes ?? [];
  const options = poll.options.map((option, i) => {
    // Checked on the card: the viewer's ballot ("your vote"), or picked and not sent yet ("selected").
    let state = '';
    if (ballot.marked.includes(i)) state = mine.includes(i) ? ', your vote' : ', selected';
    return `${option.label}, ${percents[i] ?? 0} percent${state}.`;
  });
  const status = [pollVotesLabel(poll.totalVotes, format), endSpoken];
  if (ballot.saving) status.push('saving your vote');
  else if (!ballot.canVote && ballot.voted) status.push('You voted');
  const choose = ballot.canVote && ballot.multi ? ' Choose one or more.' : '';
  return `Poll: ${sentence(poll.question)}${choose} ${options.join(' ')} ${status.join(', ')}.`;
}
