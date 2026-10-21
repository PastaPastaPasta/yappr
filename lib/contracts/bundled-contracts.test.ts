import { describe, expect, it } from 'vitest';
import { bundleKey, bundledContractsFor, staleContractIds } from './bundled-contracts';

describe('bundleKey', () => {
  it('names devnets by their devnet name and other networks by network', () => {
    expect(bundleKey('devnet', 'sakura')).toBe('devnet-sakura');
    expect(bundleKey('testnet')).toBe('testnet');
    expect(bundleKey('mainnet')).toBe('mainnet');
  });
});

describe('bundledContractsFor', () => {
  it('has a sakura and a testnet bundle with serialized contracts', async () => {
    for (const key of ['devnet-sakura', 'testnet']) {
      const bundle = await bundledContractsFor(key);
      expect(bundle?.network).toBe(key);
      const entries = Object.values(bundle?.contracts ?? {});
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.version).toBeGreaterThanOrEqual(1);
        expect(entry.bytes.length).toBeGreaterThan(0);
      }
    }
    expect(await bundledContractsFor('mainnet')).toBeUndefined();
  });
});

describe('staleContractIds', () => {
  const bundled = { a: { version: 1 }, b: { version: 2 }, c: { version: 3 } };

  it('flags a version change and a contract the network no longer has', () => {
    const latest = new Map<string, { version: number } | undefined>([
      ['a', { version: 1 }],
      ['b', { version: 3 }],
      ['c', undefined],
    ]);
    expect(staleContractIds(bundled, latest, ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });

  it('ignores ids that were never bundled', () => {
    const latest = new Map<string, { version: number } | undefined>([['d', { version: 9 }]]);
    expect(staleContractIds(bundled, latest, ['d'])).toEqual([]);
  });
});

describe('the registered thread index shape the bundles seed', () => {
  // /devnet and /staging-old (the D36 rehearsal) registered the earlier v17
  // cut, whose repliesOf starts at rootPostId: a live pin would be refused
  // there. Root and /staging run the release set, registered from the
  // live-keyed file. Each build seeds its
  // social contract from its bundle before any read, so the gate
  // (replyThreadsCarryLiveMarker) never falls back to the committed file.
  // /testing still runs the v2 contract, which has no repliesOf (and no live
  // marker, so the gate is off by topology).
  async function leadOf(bytes: string | undefined): Promise<string | undefined> {
    const [{ DataContract, PlatformVersion, ensureInitialized }, { registeredContractOf }] = await Promise.all([
      import('@dashevo/evo-sdk'), import('@/lib/registered-contracts'),
    ]);
    await ensureInitialized();
    expect(bytes).toBeDefined();
    const contract = DataContract.fromBase64(bytes ?? '', false, PlatformVersion.latest());
    return registeredContractOf(contract)?.types?.get('reply')?.indexLeads.get('repliesOf');
  }

  it('/devnet: the wasm-decoded bundled social contract keys repliesOf on rootPostId', async () => {
    expect(await leadOf((await bundledContractsFor('devnet-sakura'))?.contracts['5sgocKC9gg3RPYdTqnmWUgpatTDd5xzsdQLe6ADk6BnP']?.bytes)).toBe('rootPostId');
  });

  it('/testing: the bundled v2 social contract has no repliesOf', async () => {
    expect(await leadOf((await bundledContractsFor('testnet'))?.contracts['2qvaZNJJU2KQxSn7SB7eTyyWtjvGD8wx3cpVHZSPC4mn']?.bytes)).toBeUndefined();
  });

  it('root and /staging: the bundled registered release social contract keys repliesOf on live', async () => {
    expect(await leadOf((await bundledContractsFor('testnet'))?.contracts['4nYYMMs94m4asfQ2PdJ69uqugpfJ7PaQNjhJyHXSeLfb']?.bytes)).toBe('live');
  });

  it('/staging-old: the substituted rehearsal snapshot keys repliesOf on rootPostId', async () => {
    const snapshot = (await import('./snapshots/testnet-staging-old.json')).default as { contracts: Record<string, { bytes: string }> };
    expect(await leadOf(snapshot.contracts.AbDUiaXbJML5FQGSpt5oEdx88tXK8FPRXbAt1jwK3Us9?.bytes)).toBe('rootPostId');
  });
});
