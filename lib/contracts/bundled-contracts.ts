import type { AppNetwork } from '@/lib/constants';

/**
 * Contracts snapshotted at build time (`npm run contracts:snapshot`), keyed by
 * network. The app seeds the SDK's contract cache from the bundle on load, so
 * its first document query needs no contract round trip, then asks the network
 * (unproved, a few bytes per id) whether any bundled version is stale and
 * refetches only those, proved. Without SDK support for seeding the bundle is
 * ignored and the contracts are fetched as before.
 */

export interface BundledContract {
  /** The contract's `version` when the snapshot was taken. */
  readonly version: number;
  /** The platform-serialized contract, base64. */
  readonly bytes: string;
}

export interface ContractBundle {
  readonly network: string;
  readonly generatedAt: string;
  readonly contracts: Readonly<Record<string, BundledContract>>;
}

/** Networks with a snapshot under `./bundled/`. */
const BUNDLED_NETWORKS: readonly string[] = ['devnet-moutai', 'testnet'];

/** The bundle slot for a network: `devnet-<name>`, or the network's name. */
export function bundleKey(network: AppNetwork, devnetName?: string): string {
  return network === 'devnet' ? `devnet-${devnetName ?? ''}` : network;
}

/**
 * The bundle for a network, loaded on demand so a build ships only the
 * snapshot it uses. `undefined` for a network without one.
 */
export async function bundledContractsFor(key: string): Promise<ContractBundle | undefined> {
  if (!BUNDLED_NETWORKS.includes(key)) return undefined;
  const loaded = await import(`./bundled/${key}.json`);
  return loaded.default as ContractBundle;
}

/**
 * The ids among `ids` whose bundled version is not the network's current one,
 * or which the network no longer has. Ids missing from the bundle are not
 * stale: nothing was seeded for them.
 */
export function staleContractIds(
  bundled: Readonly<Record<string, { readonly version: number }>>,
  latest: ReadonlyMap<string, { readonly version: number } | undefined>,
  ids: readonly string[]
): string[] {
  return ids.filter((id) => {
    const entry = bundled[id];
    if (!entry) return false;
    const current = latest.get(id);
    return !current || current.version !== entry.version;
  });
}
