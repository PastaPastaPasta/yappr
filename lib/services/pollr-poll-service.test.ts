import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What createPoll writes per topology and how a poll document reads back, at
// an in-memory boundary. No network.
const mocks = vi.hoisted(() => ({
  createDocument: vi.fn(), deleteDocument: vi.fn(), settle: vi.fn(), count: vi.fn(), get: vi.fn(),
}));
vi.mock('./state-transition-service', () => ({
  stateTransitionService: { createDocument: mocks.createDocument, deleteDocument: mocks.deleteDocument },
}));
vi.mock('./identity-nonce', async (load) => ({
  ...(await load<typeof import('./identity-nonce')>()),
  settleSupersededReplaces: mocks.settle,
}));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { count: mocks.count, get: mocks.get } }) }));

const OWNER = '11111111111111111111111111111111';
const OTHER = '22222222222222222222222222222222';
const DAY = 24 * 60 * 60 * 1000;

async function loadService(topology: 'v3' | 'v5' | 'v6') {
  vi.stubEnv('NEXT_PUBLIC_POLLR_TOPOLOGY', topology);
  return (await import('./pollr-poll-service')).pollrPollService;
}

/** The document data the single create was called with. */
async function written(): Promise<Record<string, unknown>> {
  const data = mocks.createDocument.mock.calls[0][3];
  return typeof data === 'function' ? data('doc') : data;
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.createDocument.mockResolvedValue({ success: true, document: { $id: 'doc', $ownerId: OWNER } });
  mocks.settle.mockResolvedValue(0);
});
afterEach(() => vi.unstubAllEnvs());

describe('createPoll', () => {
  it('v5 writes options[], optionCount, multiChoice (even false) and endsAt', async () => {
    const service = await loadService('v5');
    const endsAt = Date.now() + DAY + 0.5;
    await service.createPoll(OWNER, { question: '  Best? ', options: [' a ', 'b', ''], endsAt });

    expect(await written()).toEqual({ question: 'Best?', options: ['a', 'b'], optionCount: 2, multiChoice: false, endsAt: Math.floor(endsAt) });
  });

  it.each([
    ['no close time', { endsAt: undefined }, /close time/],
    ['a close more than 31 days out', { endsAt: Date.now() + 32 * DAY }, /31 days/],
    ['duplicate options', { options: ['Yes', 'Yes'] }, /different/],
    ['an 81-character option', { options: ['a'.repeat(81), 'b'] }, /80 characters/],
    ['a 281-character question', { question: 'q'.repeat(281) }, /280 characters/],
  ])('v5 refuses %s before writing', async (_, overrides, message) => {
    const service = await loadService('v5');
    await expect(
      service.createPoll(OWNER, { question: 'Best?', options: ['a', 'b'], endsAt: Date.now() + DAY, ...overrides })
    ).rejects.toThrow(message);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('settles a landed, timed-out ballot replace before creating, with no vote in between', async () => {
    const service = await loadService('v5');
    const order: string[] = [];
    // The voter's last ballot replace timed out but landed: its reservation is
    // still pending, and only the proof-based settle releases it.
    mocks.settle.mockImplementation(async (owner: string, contract: string) => {
      order.push(`settle ${owner === OWNER} ${typeof contract}`);
      return 1;
    });
    mocks.createDocument.mockImplementation(async () => {
      order.push('create');
      return { success: true, document: { $id: 'doc', $ownerId: OWNER } };
    });

    await service.createPoll(OWNER, { question: 'Best?', options: ['a', 'b'], endsAt: Date.now() + DAY });
    expect(order).toEqual(['settle true string', 'create']);
  });

  it('still creates the poll when settling pending replaces fails', async () => {
    const service = await loadService('v5');
    mocks.settle.mockRejectedValue(new Error('down'));

    await service.createPoll(OWNER, { question: 'Best?', options: ['a', 'b'], endsAt: Date.now() + DAY });
    expect(mocks.createDocument).toHaveBeenCalledTimes(1);
  });

  it('v3 keeps the enumerated option fields and omits unset optionals', async () => {
    const service = await loadService('v3');
    await service.createPoll(OWNER, { question: 'Best?', options: ['a', 'b'] });

    expect(await written()).toEqual({ question: 'Best?', option0: 'a', option1: 'b' });
  });
});

describe('reading a poll', () => {
  it('keeps v5’s stored optionCount and falls back to the options read before v5', async () => {
    const service = await loadService('v5');
    mocks.createDocument.mockResolvedValue({
      success: true,
      document: { $id: 'doc', $ownerId: OWNER, question: 'q', options: ['a', 'b'], optionCount: 2, multiChoice: true, endsAt: 5 },
    });
    expect(await service.createPoll(OWNER, { question: 'q', options: ['a', 'b'], multiChoice: true, endsAt: Date.now() + DAY }))
      .toMatchObject({ options: ['a', 'b'], optionCount: 2, multiChoice: true, endsAt: 5 });

    mocks.createDocument.mockResolvedValue({ success: true, document: { $id: 'doc', $ownerId: OWNER, question: 'q', option0: 'a', option1: 'b' } });
    expect(await service.createPoll(OWNER, { question: 'q', options: ['a', 'b'], endsAt: Date.now() + DAY }))
      .toMatchObject({ optionCount: 2, multiChoice: false });
  });
});

describe('readPollOptions', () => {
  it('reads v5’s options array and the v3/v4 enumerated fields, stopping at a gap', async () => {
    const { readPollOptions } = await import('./pollr-poll-service');
    expect(readPollOptions({ options: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
    expect(readPollOptions({ option0: 'a', option1: 'b', option3: 'gap' })).toEqual(['a', 'b']);
  });
});

describe('deleting a poll (v6)', () => {
  const poll = { id: 'poll-1', ownerId: OWNER, createdAt: new Date(0), question: 'q', options: ['a', 'b'], optionCount: 2, multiChoice: false, endsAt: 5 };

  it('counts every ballot off byPoll, then deletes a poll nobody voted on', async () => {
    const service = await loadService('v6');
    // Count trees do not materialise an empty branch: no ballots is an empty map.
    mocks.count.mockResolvedValue(new Map());
    mocks.deleteDocument.mockResolvedValue({ success: true });

    expect(await service.deletePoll(poll, OWNER)).toEqual({ status: 'deleted' });
    // Landed ballot replaces are released first, as before a create.
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    expect(mocks.count).toHaveBeenCalledWith(expect.objectContaining({ documentTypeName: 'vote', where: [['pollId', '==', 'poll-1']] }));
    expect(mocks.deleteDocument).toHaveBeenCalledWith(expect.any(String), 'poll', 'poll-1', OWNER);
  });

  it('refuses without a write once any ballot names the poll, withdrawn ones included', async () => {
    const service = await loadService('v6');
    mocks.count.mockResolvedValue(new Map([['', 1n]]));

    expect(await service.deletePoll(poll, OWNER)).toEqual({ status: 'voted' });
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });

  it('reports a ballot that landed after the count (40147) as voted', async () => {
    const service = await loadService('v6');
    mocks.count.mockResolvedValue(new Map());
    mocks.deleteDocument.mockResolvedValue({
      success: false,
      error: 'Document poll-1 of type "poll" can not be deleted: it breaks its deleteConstraints rule "noBallots": 1 != 0 (code=40147)',
    });

    expect(await service.deletePoll(poll, OWNER)).toEqual({ status: 'voted' });
  });

  it('keeps a poll proven voted non-deletable, even when a lagging node later counts 0', async () => {
    const service = await loadService('v6');
    mocks.count.mockResolvedValue(new Map());
    mocks.deleteDocument.mockResolvedValue({ success: false, error: 'rejected: code=40147' });
    expect(service.hasBallots(poll.id)).toBe(false);
    expect(await service.deletePoll(poll, OWNER)).toEqual({ status: 'voted' });
    expect(service.hasBallots(poll.id)).toBe(true);

    // The reload's count lags at 0; the poll still stays permanent, with no second paid refusal.
    mocks.count.mockClear();
    mocks.deleteDocument.mockClear();
    expect(await service.deletePoll(poll, OWNER)).toEqual({ status: 'voted' });
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });

  it('remembers a positive ballot count', async () => {
    const service = await loadService('v6');
    mocks.count.mockResolvedValue(new Map([['', 2n]]));
    expect(await service.countBallots(poll.id)).toBe(2);
    expect(service.hasBallots(poll.id)).toBe(true);
    expect(service.hasBallots('other-poll')).toBe(false);
  });

  it('passes any other refusal through, and throws when the ballots cannot be counted', async () => {
    const service = await loadService('v6');
    mocks.count.mockResolvedValue(new Map());
    mocks.deleteDocument.mockResolvedValue({ success: false, error: 'Insufficient balance' });
    expect(await service.deletePoll(poll, OWNER)).toEqual({ status: 'failed', error: 'Insufficient balance' });

    mocks.count.mockRejectedValue(new Error('offline'));
    await expect(service.deletePoll(poll, OWNER)).rejects.toThrow('offline');
  });

  it('never deletes before v6 or for anyone but the owner', async () => {
    const v5 = await loadService('v5');
    expect((await v5.deletePoll(poll, OWNER)).status).toBe('failed');
    vi.resetModules();
    const v6 = await loadService('v6');
    expect((await v6.deletePoll(poll, OTHER)).status).toBe('failed');
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });
});

describe('fetchPoll', () => {
  it('reads a missing poll as null but lets a failed read throw', async () => {
    const service = await loadService('v6');
    mocks.get.mockResolvedValue(undefined);
    expect(await service.fetchPoll('gone')).toBeNull();

    mocks.get.mockRejectedValue(new Error('timeout'));
    await expect(service.fetchPoll('other')).rejects.toThrow('timeout');
    // getPoll keeps swallowing it, as before.
    expect(await service.getPoll('other')).toBeNull();
  });
});
