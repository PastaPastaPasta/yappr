import type { ElectionContest, SeatedTeam } from '@/lib/services/moderation-election-service'

/** Consumer-facing election result. Only proved poll times are used, never a local estimate. */
export function electionResult(contest: ElectionContest, seated: SeatedTeam | null, formatDate = (ms: number) => new Date(ms).toLocaleString()): string {
  const winner = contest.winner
  const decidedAt = winner?.decidedAtMs
  const date = decidedAt !== null && decidedAt !== undefined && Number.isFinite(decidedAt) && decidedAt > 0
    ? formatDate(decidedAt) : null
  if (winner) {
    switch (winner.kind.toLowerCase()) {
      case 'wonbyidentity':
        return seated && seated.leaderId === winner.identityId
          ? `Elected — this team was seated${date ? ` on ${date}` : ''}.`
          : `Team elected${date ? ` on ${date}` : ''}.`
      case 'locked':
        return `Election locked — no team was elected${date ? ` on ${date}` : ''}.`
      case 'nowinner':
        return `Voting ended${date ? ` on ${date}` : ''} — no team was elected.`
      default:
        return `Voting ended${date ? ` on ${date}` : ''}.`
    }
  }
  return contest.endsAtMs !== null && Number.isFinite(contest.endsAtMs) && contest.endsAtMs > 0
    ? `Voting in progress — ends ${formatDate(contest.endsAtMs)}.`
    : 'Voting in progress.'
}
