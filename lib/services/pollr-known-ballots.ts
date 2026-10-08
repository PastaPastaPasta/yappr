/**
 * Polls this client knows have a ballot. Ballots are never deleted, so on v6
 * such a poll can never be deleted again (its `noBallots` rule): the set only
 * grows, and a later count of 0 from a node that lags behind cannot bring the
 * delete back. Filled wherever the evidence is seen: an own ballot document
 * read (withdrawn ones included), a confirmed ballot write, a positive ballot
 * count, a tallied selection, or a 40147.
 */
const pollsWithBallots = new Set<string>();

/** Record that a ballot names the poll. */
export function markPollHasBallots(pollId: string): void {
  pollsWithBallots.add(pollId);
}

/** Whether the poll is known to have a ballot, so it can never be deleted. */
export function pollHasKnownBallots(pollId: string): boolean {
  return pollsWithBallots.has(pollId);
}
