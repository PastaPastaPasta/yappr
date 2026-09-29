import bs58 from 'bs58';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  voting: { contestedResourceVoteState: vi.fn(), votePollsByEndDate: vi.fn() },
  moderationCharters: { submittedCharters: vi.fn(), team: vi.fn(), submittedCharter: vi.fn() },
  documents: { get: vi.fn() },
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => sdk }));
import { MODERATION_CHARTERS_CONTRACT_ID, contestEndFromPolls, contestVotePoll, moderationElectionService, toProposal, toReason } from './moderation-election-service';

const target = bs58.encode(new Uint8Array(32).fill(9));
const leader = bs58.encode(new Uint8Array(32).fill(1));
const reasonA = bs58.encode(new Uint8Array(32).fill(2));

describe('moderation election mappers', () => {
  it('queries the seat contest with the target id as a base58 STRING', () => {
    expect(contestVotePoll(target)).toEqual({
      dataContractId: MODERATION_CHARTERS_CONTRACT_ID,
      documentTypeName: 'electedCharter',
      indexName: 'byTargetContract',
      indexValues: [target],
    });
    expect(typeof contestVotePoll(target).indexValues[0]).toBe('string');
  });

  it('maps a submittedCharter, including reasons given as bytes', () => {
    const proposal = toProposal({
      $id: 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88', $ownerId: leader, $createdAt: 5,
      description: 'We moderate spam', reasons: [new Uint8Array(32).fill(2)],
      moderatorsShare: 80, rewardSplit: { leader: 20, equal: 30, actions: 50 },
    });
    expect(proposal).toEqual({
      id: 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88', leaderId: leader, description: 'We moderate spam',
      reasonIds: [reasonA], moderatorsShare: 80, rewardSplit: { leader: 20, equal: 30, actions: 50 }, createdAt: 5,
    });
    expect(toProposal({ $id: leader, $ownerId: leader }).moderatorsShare).toBeNull();
  });

  it('maps a reason document', () => {
    expect(toReason({ $id: reasonA, code: 'SPM', label: 'Spam' })).toEqual({ id: reasonA, code: 'SPM', label: 'Spam' });
  });

  it('finds the contest end among vote polls by end date', () => {
    const poll = (indexValue: unknown, contractId = MODERATION_CHARTERS_CONTRACT_ID) =>
      ({ contractId, documentTypeName: 'electedCharter', indexName: 'byTargetContract', indexValues: [indexValue] });
    const entries = [
      { timestampMs: 100n, votePolls: [poll(bs58.encode(new Uint8Array(32).fill(8)))] },
      { timestampMs: 200n, votePolls: [poll(target, leader), poll(target)] },
    ];
    expect(contestEndFromPolls(entries, target)).toBe(200);
    // Identifiers as bytes (a wasm toObject shape) normalise the same way.
    expect(contestEndFromPolls([{ timestampMs: 300, votePolls: [poll(bs58.decode(target), bs58.decode(MODERATION_CHARTERS_CONTRACT_ID) as unknown as string)] }], target)).toBe(300);
    expect(contestEndFromPolls(entries, reasonA)).toBeNull();
  });
});

describe('reading the contest', () => {
  beforeEach(() => {
    // The topology is resolved once per module, by whichever read comes first.
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9');
    sdk.voting.contestedResourceVoteState.mockReset();
    sdk.voting.votePollsByEndDate.mockReset();
  });
  const entry = (timestampMs: number, indexValue: string) => ({
    timestampMs: BigInt(timestampMs), free: vi.fn(),
    votePolls: [{ toJSON: () => ({ contractId: MODERATION_CHARTERS_CONTRACT_ID, documentTypeName: 'electedCharter', indexName: 'byTargetContract', indexValues: [indexValue] }) }],
  });
  const other = bs58.encode(new Uint8Array(32).fill(4));
  const state = (contenders: unknown[]) => ({ contenders, abstainVoteTally: 0, lockVoteTally: 0, winner: undefined, free: vi.fn() });

  it('answers "no contest yet" (null) when nobody has entered, without failing', async () => {
    sdk.voting.contestedResourceVoteState.mockResolvedValueOnce(state([]));
    sdk.voting.votePollsByEndDate.mockResolvedValueOnce([]);
    await expect(moderationElectionService.getContest(target)).resolves.toEqual({ contest: null, endTimeFailed: false });
  });

  it('pages past the first 100 vote polls to find the end time', async () => {
    sdk.voting.contestedResourceVoteState.mockResolvedValueOnce(state([{ identityId: leader, voteTally: 3 }]));
    sdk.voting.votePollsByEndDate
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => entry(1000 + i, other)))
      .mockResolvedValueOnce([entry(5000, target)]);
    const { contest, endTimeFailed } = await moderationElectionService.getContest(target);
    expect(contest).toMatchObject({ contenders: [{ identityId: leader, votes: 3 }], endsAtMs: 5000 });
    expect(endTimeFailed).toBe(false);
    expect(sdk.voting.votePollsByEndDate).toHaveBeenCalledTimes(2);
    // The next page re-reads the last timestamp, whose group the limit may have
    // cut short, passing its bigint back as is (wasm-sdk beta.7, platform#5139).
    expect(sdk.voting.votePollsByEndDate.mock.calls[0][0]).not.toHaveProperty('startTimeMs');
    expect(sdk.voting.votePollsByEndDate.mock.calls[1][0]).toMatchObject({ startTimeMs: 1099n, startTimeIncluded: true });
  });

  it('counts polls, not timestamp groups, when deciding a page was full', async () => {
    // 100 polls in 50 timestamps: a full page, though it holds only 50 entries.
    const pair = (timestampMs: number) => {
      const one = entry(timestampMs, other);
      return { ...one, votePolls: [...one.votePolls, ...one.votePolls] };
    };
    sdk.voting.contestedResourceVoteState.mockResolvedValueOnce(state([{ identityId: leader, voteTally: 1 }]));
    sdk.voting.votePollsByEndDate
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => pair(2000 + i)))
      .mockResolvedValueOnce([entry(2049, target)]);
    const { contest } = await moderationElectionService.getContest(target);
    expect(contest?.endsAtMs).toBe(2049);
    expect(sdk.voting.votePollsByEndDate.mock.calls[1][0]).toMatchObject({ startTimeMs: 2049n, startTimeIncluded: true });
  });

  it('moves past a timestamp that fills a whole page on its own', async () => {
    const crowded = entry(3000, other);
    const full = { ...crowded, votePolls: Array.from({ length: 100 }, () => crowded.votePolls[0]) };
    sdk.voting.contestedResourceVoteState.mockResolvedValueOnce(state([{ identityId: leader, voteTally: 1 }]));
    sdk.voting.votePollsByEndDate.mockResolvedValueOnce([full]).mockResolvedValueOnce([entry(3001, target)]);
    const { contest } = await moderationElectionService.getContest(target);
    expect(contest?.endsAtMs).toBe(3001);
    expect(sdk.voting.votePollsByEndDate.mock.calls[1][0]).toMatchObject({ startTimeMs: 3000n, startTimeIncluded: false });
  });
});

describe('getStatus reports failed reads instead of passing them off as empty', () => {
  const noContest = () => ({ contenders: [], abstainVoteTally: 0, lockVoteTally: 0, winner: undefined, free: vi.fn() });
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', 'v9');
    for (const fn of [sdk.voting.contestedResourceVoteState, sdk.voting.votePollsByEndDate, sdk.moderationCharters.submittedCharters, sdk.moderationCharters.team, sdk.moderationCharters.submittedCharter, sdk.documents.get]) fn.mockReset();
    sdk.voting.contestedResourceVoteState.mockResolvedValue(noContest());
    sdk.voting.votePollsByEndDate.mockResolvedValue([]);
    sdk.moderationCharters.submittedCharters.mockResolvedValue(new Map());
    sdk.moderationCharters.team.mockResolvedValue(undefined);
  });

  it('a clean read with nothing filed reports no failures', async () => {
    const status = await moderationElectionService.getStatus(target);
    expect(status?.failures).toEqual([]);
    expect(status?.seated).toBeNull();
  });

  it('a timed-out team read is flagged, not rendered as "no team"', async () => {
    sdk.moderationCharters.team.mockRejectedValue(new Error('504 gateway timeout'));
    const status = await moderationElectionService.getStatus(target);
    expect(status?.failures).toContain('seatedTeam');
  });

  it('flags failed proposal and contest reads, keeping whatever else was read', async () => {
    sdk.moderationCharters.submittedCharters.mockRejectedValue(new Error('offline'));
    sdk.voting.contestedResourceVoteState.mockRejectedValue(new Error('offline'));
    const status = await moderationElectionService.getStatus(target);
    expect(status?.failures).toEqual(expect.arrayContaining(['proposals', 'contest']));
    expect(status?.proposals).toEqual([]);
    expect(status?.contest).toBeNull();
  });

  it('flags the contest end time when only the end-date read failed', async () => {
    sdk.voting.contestedResourceVoteState.mockResolvedValue({ ...noContest(), contenders: [{ identityId: leader, voteTally: 1 }] });
    sdk.voting.votePollsByEndDate.mockRejectedValue(new Error('offline'));
    const status = await moderationElectionService.getStatus(target);
    expect(status?.contest?.contenders).toHaveLength(1);
    expect(status?.failures).toEqual(['contestEnd']);
  });

  it('stops the end-date walk at the latest end a live contest can have', async () => {
    const now = 1_790_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      sdk.voting.contestedResourceVoteState.mockResolvedValue({ ...noContest(), contenders: [{ identityId: leader, voteTally: 0 }] });
      await moderationElectionService.getStatus(target);
      const query = sdk.voting.votePollsByEndDate.mock.calls[0][0];
      // v9 declares 3600 s join and vote windows; 10 minutes of slack on top.
      expect(query).toMatchObject({ endTimeMs: now + 7_200_000 + 600_000, endTimeIncluded: true, orderAscending: true });
      expect(query).not.toHaveProperty('startTimeMs');
    } finally {
      clock.mockRestore();
    }
  });
});

describe('electionView', () => {
  const base = { declaration: {} as never, targetContractId: target, proposals: [], contest: null, seated: null, seatedReasons: [], failures: [] as never[] };
  it('states "No election yet" only when every read succeeded', async () => {
    const { electionView } = await import('./moderation-election-service');
    expect(electionView({ ...base }, false)).toEqual({ phase: 'No election yet', error: null, emptyStateKnown: true });
    const timedOut = electionView({ ...base, failures: ['seatedTeam'] }, false);
    expect(timedOut.phase).toBe('Unknown');
    expect(timedOut.emptyStateKnown).toBe(false);
    expect(timedOut.error).toMatch(/Could not read the seated team/);
  });

  it('keeps what was read and reports the whole-read failure', async () => {
    const { electionView } = await import('./moderation-election-service');
    const seated = { electedCharterId: leader, submittedCharterId: leader, leaderId: leader, members: [] };
    expect(electionView({ ...base, seated, failures: ['proposals'] }, false)).toMatchObject({ phase: 'Seated', emptyStateKnown: false });
    expect(electionView(null, true)).toMatchObject({ phase: 'Unknown', error: 'Could not read the election state.' });
  });
});
