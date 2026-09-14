import { describe, expect, it } from 'vitest';
import { bundleKey, bundledContractsFor, staleContractIds } from './bundled-contracts';

describe('bundleKey', () => {
  it('names devnets by their devnet name and other networks by network', () => {
    expect(bundleKey('devnet', 'moutai')).toBe('devnet-moutai');
    expect(bundleKey('testnet')).toBe('testnet');
    expect(bundleKey('mainnet')).toBe('mainnet');
  });
});

describe('bundledContractsFor', () => {
  it('has a moutai and a testnet bundle with serialized contracts', async () => {
    for (const key of ['devnet-moutai', 'testnet']) {
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
