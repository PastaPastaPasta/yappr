import { useEffect, useState } from 'react';
import { create } from 'zustand';

import type { CardPoll } from './types';

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

/** The time now, read again every 30 s while `endsAt` is still ahead (an open poll closes on screen). */
export function usePollNow(endsAt: Date | null): number {
  const [now, setNow] = useState(Date.now);
  const open = endsAt !== null && endsAt.getTime() > now;
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);
  return now;
}

/** Whole-number shares that are 0 for an empty poll. */
export function pollPercents(poll: CardPoll): number[] {
  return poll.options.map((o) => (poll.totalVotes > 0 ? Math.round((o.votes / poll.totalVotes) * 100) : 0));
}

/** A ballot as one comparable string: its option indexes in order. */
export const ballotKey = (choices: readonly number[] | null | undefined) => (choices ? [...choices].sort((a, b) => a - b).join(',') : '');

/**
 * The options picked but not sent yet, per poll: the card shows them and the
 * post's screen-reader actions pick them (the card is one element, UX_SPEC
 * §6.2), so both share one selection. A ballot read or saved since starts it
 * over from the viewer's votes.
 */
const useSelections = create<Record<string, { cast: string; selected: number[] }>>()(() => ({}));

const pollKey = (poll: CardPoll) => poll.id ?? poll.question;

/** Forgets every unsent pick (tests: each starts with none). */
export function clearPollSelections(): void {
  useSelections.setState({}, true);
}

export function usePollSelection(poll: CardPoll | null): [number[], (selected: number[]) => void] {
  const key = poll ? pollKey(poll) : '';
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
  closed: boolean;
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
export function pollBallot(poll: CardPoll, selected: number[], now: number, canSend: boolean): PollBallot {
  const closed = poll.endsAt !== null && poll.endsAt.getTime() <= now;
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
    closed,
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

/**
 * The poll for a screen reader (D-957): the question, each option with its
 * share and whether it is picked, and the count and close.
 */
export function pollSpokenLabel(poll: CardPoll, ballot: PollBallot, now: number, format: (n: number) => string): string {
  const percents = pollPercents(poll);
  const mine = poll.myVotes ?? [];
  const options = poll.options.map((option, i) => {
    // Checked on the card: the viewer's ballot ("your vote"), or picked and not sent yet ("selected").
    let state = '';
    if (ballot.marked.includes(i)) state = mine.includes(i) ? ', your vote' : ', selected';
    return `${option.label}, ${percents[i] ?? 0} percent${state}.`;
  });
  const status = [pollVotesLabel(poll.totalVotes, format), pollEndLabel(poll.endsAt, now)];
  if (!ballot.canVote && ballot.voted) status.push('You voted');
  const choose = ballot.canVote && ballot.multi ? ' Choose one or more.' : '';
  return `Poll: ${poll.question}.${choose} ${options.join(' ')} ${status.join(', ')}.`;
}
