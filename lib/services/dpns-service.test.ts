import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, composite, dpns, identities, epoch, topology } = vi.hoisted(() => ({
  query: vi.fn(),
  composite: vi.fn(),
  dpns: { isValidUsername: vi.fn(), isContestedUsername: vi.fn(), isNameAvailable: vi.fn(), registerName: vi.fn(), convertToHomographSafe: vi.fn(), resolveName: vi.fn() },
  identities: { fetch: vi.fn() },
  epoch: { current: vi.fn() },
  topology: { indexOnly: false },
}));
vi.mock('./evo-sdk-service', () => ({
  getEvoSdk: async () => ({ documents: { query, composite }, dpns, identities, epoch }),
}));
vi.mock('@/lib/contract-topology', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contract-topology')>()),
  likesAreIndexOnly: () => topology.indexOnly,
}));
vi.mock('./signer-service', () => ({ signerService: {} }));
vi.mock('@/lib/crypto/keys', () => ({ matchIdentityKey: () => ({ ok: false, reason: 'no-match' }) }));
import { describeDpnsRegistrationError, dpnsService, formatCreditsAsDash, minimumContestFundCredits } from './dpns-service';

beforeEach(() => {
  vi.useFakeTimers();
  dpnsService.clearCache();
  query.mockReset().mockResolvedValue([]);
  composite.mockReset();
  topology.indexOnly = false;
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
    query.mockResolvedValueOnce([{ $ownerId: '111111111', records: { identity: '111111111' }, label: 'recovered' }]);
    expect(await dpnsService.resolveUsername('111111111')).toBe('recovered.dash');
    expect(query).toHaveBeenCalledTimes(2);
  });

  // The auth session adapter relies on this to tell a failed lookup from "no name".
  it('caches a proven absence but not a failed reverse lookup', async () => {
    query.mockRejectedValueOnce(new Error('offline'));
    expect(await dpnsService.resolveUsername('111111111')).toBeNull();
    expect(dpnsService.hasCachedAbsence('111111111')).toBe(false);
    expect(await dpnsService.resolveUsername('111111111')).toBeNull();
    expect(dpnsService.hasCachedAbsence('111111111')).toBe(true);
  });

  it('does not report an absence when a failed lookup races a name seeded elsewhere', async () => {
    query.mockImplementationOnce(async () => {
      dpnsService.seedUsernames(new Map([['111111111', 'real.dash']]));
      throw new Error('offline');
    });
    expect(await dpnsService.resolveUsername('111111111')).toBeNull();
    expect(dpnsService.hasCachedUsername('111111111')).toBe(true);
    expect(dpnsService.hasCachedAbsence('111111111')).toBe(false);
  });

  it('resolves all aliases for a connection page with one in-query', async () => {
    query.mockResolvedValue([
      { $ownerId: '111111111', records: { identity: '111111111' }, label: 'zeta' },
      { $ownerId: '111111111', records: { identity: '111111111' }, label: 'alpha' },
      { $ownerId: '222222222', records: { identity: '222222222' }, label: 'bravo' },
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
      $ownerId: '111111111', records: { identity: '111111111' }, label: `longalias${i}`,
    }));
    query.mockResolvedValueOnce(aliases.slice(0, 99))
      .mockResolvedValueOnce(aliases)
      .mockResolvedValueOnce([{ $ownerId: '111111111', records: { identity: '111111111' }, label: 'abc' }])
      .mockResolvedValueOnce([{ $ownerId: '222222222', records: { identity: '222222222' }, label: 'def' }]);
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

describe('DPNS names registered for another identity', () => {
  // Platform does not check `records.identity` against the owner, so the
  // attacker can register a name that points at the victim.
  const victim = '111111111';
  const attacker = '222222222';
  const forged = { $ownerId: attacker, records: { identity: victim }, label: 'aa', normalizedParentDomainName: 'dash' };
  const own = { $ownerId: victim, records: { identity: victim }, label: 'victim', normalizedParentDomainName: 'dash' };

  beforeEach(() => {
    dpns.convertToHomographSafe.mockReset().mockImplementation(async (label: string) => label.replace(/[oO]/g, '0').replace(/[ilIL]/g, '1'));
    dpns.resolveName.mockReset().mockResolvedValue(victim);
  });

  it('leaves a forged name out of the victim\'s aliases and primary name', async () => {
    query.mockResolvedValue([forged, own]);
    expect((await dpnsService.getAllUsernamesSortedBatch([victim])).get(victim)).toEqual(['victim.dash']);
    expect(await dpnsService.resolveUsername(victim)).toBe('victim.dash');
    // Nor is the forged name cached as resolving to the victim.
    query.mockResolvedValue([forged]);
    expect(await dpnsService.resolveIdentity('aa')).toBeNull();
  });

  it('proves a victim named only by forgeries unnamed', async () => {
    query.mockResolvedValue([forged]);
    expect(await dpnsService.resolveUsername(victim)).toBeNull();
  });

  it('resolves a forged name to nobody, not the victim the SDK resolver names', async () => {
    query.mockResolvedValue([forged]);
    expect(await dpnsService.resolveIdentity('aa.dash')).toBeNull();
    expect(dpns.resolveName).not.toHaveBeenCalled();
  });

  it('resolves an owned name by its homograph-safe label', async () => {
    query.mockResolvedValue([{ ...own, label: 'Alice' }]);
    expect(await dpnsService.resolveIdentity('Alice.dash')).toBe(victim);
    expect(query.mock.calls[0][0].where).toEqual([['normalizedLabel', '==', 'a11ce'], ['normalizedParentDomainName', '==', 'dash']]);
  });

  it('still reports a forged name as taken', async () => {
    dpns.isNameAvailable.mockRejectedValueOnce(new Error('offline'));
    query.mockResolvedValue([forged]);
    expect(await dpnsService.isUsernameAvailable('aa')).toBe(false);
  });

  it('drops forged names from search results', async () => {
    query.mockResolvedValue([forged, own]);
    expect(await dpnsService.searchUsernamesWithDetails('a')).toEqual([{ username: 'victim.dash', ownerId: victim }]);
  });
});

describe('DPNS name reads that fail', () => {
  const owner = '111111111';
  const alice = { $ownerId: owner, records: { identity: owner }, label: 'alice', normalizedParentDomainName: 'dash' };

  beforeEach(() => {
    dpns.convertToHomographSafe.mockReset().mockImplementation(async (label: string) => label);
  });

  it('rejects a failed prefix search strictly, and finds nothing softly', async () => {
    query.mockRejectedValue(new Error('Request timed out after 8000ms'));
    await expect(dpnsService.findUsernamesByPrefix('ali')).rejects.toThrow(/timed out/);
    expect(await dpnsService.searchUsernamesWithDetails('ali')).toEqual([]);
  });

  it('rejects a failed name resolution strictly, and resolves nobody softly', async () => {
    query.mockRejectedValue(new Error('invalid quorum: Quorum not found in cache for hash: 00ab'));
    await expect(dpnsService.findIdentityByName('alice')).rejects.toThrow(/quorum/);
    expect(await dpnsService.resolveIdentity('alice')).toBeNull();
  });

  it('answers null only when DPNS answered that nobody owns the name', async () => {
    expect(await dpnsService.findIdentityByName('nobody')).toBeNull();
    query.mockResolvedValue([alice]);
    expect(await dpnsService.findIdentityByName('Alice.dash')).toBe(owner);
  });

  it('falls back to the ordinary search after a composite search fails, and rejects only when that fails too', async () => {
    topology.indexOnly = true;
    composite.mockRejectedValue(new Error('deadline exceeded'));
    query.mockResolvedValueOnce([alice]);
    expect(await dpnsService.findUsernamesByPrefix('ali')).toEqual([{ username: 'alice.dash', ownerId: owner }]);

    query.mockRejectedValueOnce(new Error('invalid quorum: Quorum not found in cache for hash: 00ab'));
    await expect(dpnsService.findUsernamesByPrefix('ali')).rejects.toThrow(/quorum/);
  });

  it('falls back to the ordinary search when the composite search is refused for another reason', async () => {
    topology.indexOnly = true;
    composite.mockRejectedValueOnce(new Error('composite queries are not supported'));
    query.mockResolvedValue([alice]);
    expect(await dpnsService.findUsernamesByPrefix('ali')).toEqual([{ username: 'alice.dash', ownerId: owner }]);
  });
});

describe('describeDpnsRegistrationError (contested names, 4.2.0-beta.5)', () => {
  it('names the current price when others joined the vote first (40114)', () => {
    const message = describeDpnsRegistrationError(new Error('Contest for document 8NAd was not paid for, needs payment of 20000000000 Credits'));
    expect(message).toMatch(/others joined the vote/i);
    expect(message).toContain('0.2 DASH');
  });

  it('prints an odd price to the duff, rounded up, not as a float', () => {
    const message = describeDpnsRegistrationError(new Error('Contest for document 8NAd was not paid for, needs payment of 12345678901 Credits'));
    expect(message).toContain('(0.12345679 DASH now)');
  });

  it('says a full contest is closed rather than asking for more (40141)', () => {
    expect(describeDpnsRegistrationError(new Error('The vote poll P already has 1000 contenders, the most a contest accepts')))
      .toMatch(/closed to new registrations/i);
  });

  it('says a contest past its join window cannot be joined (40111)', () => {
    expect(describeDpnsRegistrationError(new Error('Document Contest for vote_poll V1 is not joinable ContestInfo, it started 1 and it is now 2, and you can only join for 3')))
      .toMatch(/too long to join/i);
    expect(describeDpnsRegistrationError(new Error('consensus error code=40111'))).toMatch(/too long to join/i);
  });

  it('points a node that still refuses contested names before epoch 4 at a non-contested name (10418)', () => {
    expect(describeDpnsRegistrationError(new Error('Contested documents are not allowed until epoch 4. Current epoch is 0')))
      .toMatch(/20 or more characters/i);
  });

  it('mentions the contest fund, without a hard-coded price, when the identity is short of credits', () => {
    const message = describeDpnsRegistrationError(new Error('Insufficient identity 9t2e balance 5000000000 required 10020000000'));
    expect(message).toMatch(/contest fund/i);
    expect(message).not.toMatch(/\d\s*DASH/);
  });

  it('passes any other error through unchanged', () => {
    expect(describeDpnsRegistrationError(new Error('Username alice is already taken'))).toBe('Username alice is already taken');
  });
});

describe('DPNS credit amounts', () => {
  it('formats credits as DASH exactly, to the duff', () => {
    expect(formatCreditsAsDash(20_000_000_000n)).toBe('0.2');
    expect(formatCreditsAsDash(100_000_000_000n)).toBe('1');
    expect(formatCreditsAsDash(6_989_772_426n)).toBe('0.06989773');
    // Just short of 0.1 DASH: a balance must not read as the price it misses.
    expect(formatCreditsAsDash(9_999_999_999n, 'down')).toBe('0.09999999');
    expect(formatCreditsAsDash(9_999_999_999n)).toBe('0.1');
    expect(formatCreditsAsDash(0n)).toBe('0');
    // Past Number's 2^53: a float division would lose the last digits.
    expect(formatCreditsAsDash(123_456_789_012_345_678_000n)).toBe('1234567890.12345678');
  });

  it('knows the lowest contest fund per protocol version', () => {
    expect(minimumContestFundCredits(14)).toBe(10_000_000_000n);
    expect(minimumContestFundCredits(null)).toBe(10_000_000_000n);
    expect(minimumContestFundCredits(12)).toBe(20_000_000_000n);
  });
});

describe('contested DPNS registration without the contest fund', () => {
  beforeEach(() => {
    dpns.isValidUsername.mockReset().mockResolvedValue(true);
    dpns.isContestedUsername.mockReset().mockResolvedValue(true);
    dpns.isNameAvailable.mockReset().mockResolvedValue(true);
    dpns.registerName.mockReset().mockResolvedValue({});
    epoch.current.mockReset().mockResolvedValue({ protocolVersion: 14 });
    // QA S3-04: 0.0699 DASH, short of the 0.1 DASH protocol-14 fund.
    identities.fetch.mockReset().mockResolvedValue({ balance: 6_989_772_426n, publicKeys: [] });
  });

  it('refuses before the preorder is paid', async () => {
    await expect(dpnsService.registerUsername('qabetafivegus', 'B', 'wif'))
      .rejects.toThrow(/pays at least 0\.1 DASH .* has 0\.06989772 DASH/);
    expect(dpns.registerName).not.toHaveBeenCalled();
  });

  it('still checks the lowest fund when the epoch cannot be read', async () => {
    epoch.current.mockRejectedValue(new Error('offline'));
    await expect(dpnsService.registerUsername('qabetafivegus', 'B', 'wif')).rejects.toThrow(/at least 0\.1 DASH/);
    expect(dpns.registerName).not.toHaveBeenCalled();
  });

  it('reports the failed name as contested', async () => {
    const [result] = await dpnsService.registerUsernamesSequentially([{ label: 'qabetafivegus', identityId: 'B', privateKeyWif: 'wif' }]);
    expect(result).toMatchObject({ success: false, isContested: true });
    expect(result.error).toMatch(/contested name/);
  });

  it('does not read the epoch for a name that is not contested', async () => {
    dpns.isContestedUsername.mockResolvedValue(false);
    // Past the fund check, key matching fails on the empty key list.
    await expect(dpnsService.registerUsername('a-long-uncontested-name-2', 'B', 'wif')).rejects.toThrow(/No suitable signing key/);
    expect(epoch.current).not.toHaveBeenCalled();
  });
});
