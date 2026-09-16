import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('./evo-sdk-service', () => ({ getEvoSdk: async () => ({ documents: { query } }) }));
vi.mock('./signer-service', () => ({ signerService: {} }));
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: vi.fn() }));
import { dpnsService } from './dpns-service';

beforeEach(() => {
  vi.useFakeTimers();
  dpnsService.clearCache();
  query.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe('DPNS username format validation', () => {
  // Boundary and character cases verified against the SDK's isValidUsername.
  it.each(['abc', 'AbC', 'qa-ordered-9511', '123', 'a'.repeat(20), 'a'.repeat(63)])(
    'accepts the valid DPNS label %s', (label) => {
      expect(dpnsService.getUsernameValidationError(label)).toBeNull();
    }
  );

  it.each(['', 'ab', 'a'.repeat(64), 'qa_user', '-abc', 'abc-', 'a--b', 'a b', 'a.b', 'ąbc'])(
    'rejects the invalid DPNS label %s', (label) => {
      expect(dpnsService.getUsernameValidationError(label)).not.toBeNull();
    }
  );
});

describe('DPNS composite cache seeds', () => {
  it('bounds and deduplicates identity requests above 100 values', async () => {
    const ids = Array.from({ length: 121 }, (_, i) => `identity${i}`);
    const names = await dpnsService.getAllUsernamesSortedBatch([...ids, ...ids]);
    expect(names.size).toBe(121);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.every(([q]) => q.where[0][2].length <= 40)).toBe(true);
    await dpnsService.getAllUsernamesSortedBatch(ids);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('does not cache a failed alias chunk as an absence', async () => {
    query.mockRejectedValueOnce(new Error('offline'));
    expect((await dpnsService.getAllUsernamesSortedBatch(['111111111'])).has('111111111')).toBe(false);
    query.mockResolvedValueOnce([{ records: { identity: '111111111' }, label: 'recovered' }]);
    expect(await dpnsService.resolveUsername('111111111')).toBe('recovered.dash');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('resolves all aliases for a connection page with one in-query', async () => {
    query.mockResolvedValue([
      { records: { identity: '111111111' }, label: 'zeta' },
      { records: { identity: '111111111' }, label: 'alpha' },
      { records: { identity: '222222222' }, label: 'bravo' },
    ]);

    const names = await dpnsService.getAllUsernamesSortedBatch(['111111111', '222222222']);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].where).toEqual([['records.identity', 'in', ['111111111', '222222222']]]);
    expect(names.get('111111111')).toEqual(['zeta.dash', 'alpha.dash']);
    expect(names.get('222222222')).toEqual(['bravo.dash']);
    expect(await dpnsService.resolveUsername('111111111')).toBe('zeta.dash');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('should expire proven absences after five minutes', async () => {
    dpnsService.seedUsernames(new Map([['111111111', null]]));
    expect((await dpnsService.resolveUsernamesBatch(['111111111'])).get('111111111')).toBeNull();
    expect(query).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300_001);
    await dpnsService.resolveUsernamesBatch(['111111111']);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('should invalidate an absence when a username is registered or cache is cleared', async () => {
    dpnsService.seedUsernames(new Map([['111111111', null]]));
    dpnsService.clearCache(undefined, '111111111');
    await dpnsService.resolveUsernamesBatch(['111111111']);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('should retry crowded batches per identity and paginate aliases before choosing primary names', async () => {
    const aliases = Array.from({ length: 100 }, (_, i) => ({
      $id: String(i + 1).replace(/0/g, '1'),
      records: { identity: '111111111' }, label: `longalias${i}`,
    }));
    query.mockResolvedValueOnce(aliases.slice(0, 99))
      .mockResolvedValueOnce(aliases)
      .mockResolvedValueOnce([{ records: { identity: '111111111' }, label: 'abc' }])
      .mockResolvedValueOnce([{ records: { identity: '222222222' }, label: 'def' }]);
    const names = await dpnsService.resolveUsernamesBatch(['111111111', '222222222']);
    expect(names.get('111111111')).toBe('abc.dash');
    expect(names.get('222222222')).toBe('def.dash');
    expect(query.mock.calls[1][0].where).toEqual([['records.identity', '==', '111111111']]);
    expect(query.mock.calls[2][0].startAfter).toBe(aliases[99].$id);
    expect(query.mock.calls[3][0].where).toEqual([['records.identity', '==', '222222222']]);
  });

  it('should replace stale names with absences and absences with new names', async () => {
    dpnsService.seedUsernames(new Map([['111111111', 'old.dash']]));
    dpnsService.seedUsernames(new Map([['111111111', null]]));
    expect(await dpnsService.resolveUsername('111111111')).toBeNull();
    dpnsService.seedUsernames(new Map([['111111111', 'new.dash']]));
    expect(await dpnsService.resolveUsername('111111111')).toBe('new.dash');
    expect(query).not.toHaveBeenCalled();
  });
});
