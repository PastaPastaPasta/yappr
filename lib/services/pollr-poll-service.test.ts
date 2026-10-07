import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What createPoll writes per topology and how a poll document reads back, at
// an in-memory boundary. No network.
const mocks = vi.hoisted(() => ({ createDocument: vi.fn() }));
vi.mock('./state-transition-service', () => ({ stateTransitionService: { createDocument: mocks.createDocument } }));
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({}) }));

const OWNER = '11111111111111111111111111111111';
const DAY = 24 * 60 * 60 * 1000;

async function loadService(topology: 'v3' | 'v5') {
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

  it('v3 keeps the enumerated option fields and omits unset optionals', async () => {
    const service = await loadService('v3');
    await service.createPoll(OWNER, { question: 'Best?', options: ['a', 'b'] });

    expect(await written()).toEqual({ question: 'Best?', option0: 'a', option1: 'b' });
  });
});

describe('readPollOptions', () => {
  it('reads v5’s options array and the v3/v4 enumerated fields, stopping at a gap', async () => {
    const { readPollOptions } = await import('./pollr-poll-service');
    expect(readPollOptions({ options: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
    expect(readPollOptions({ option0: 'a', option1: 'b', option3: 'gap' })).toEqual(['a', 'b']);
  });
});
