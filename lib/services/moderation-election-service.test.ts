import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./evo-sdk-service', () => ({ getEvoSdk: vi.fn() }));
import { MODERATION_CHARTERS_CONTRACT_ID, contestEndFromPolls, contestVotePoll, toProposal, toReason } from './moderation-election-service';

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
    expect(contestEndFromPolls(entries, reasonA)).toBeNull();
  });
});
