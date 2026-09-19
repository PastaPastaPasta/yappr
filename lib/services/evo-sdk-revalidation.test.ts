import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same mocking pattern as evo-sdk-reconnect.test.ts, but with a populated
// contract bundle so initialization seeds the SDK and schedules the background
// revalidation, which outlives the installation of the failure observer.
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  fetch: vi.fn(),
  addKnown: vi.fn(),
  getMany: vi.fn(),
  getLatestVersions: vi.fn(),
  instances: [] as { options: unknown }[],
}));
vi.mock('@dashevo/evo-sdk', () => ({
  EvoSDK: class {
    connect = mocks.connect;
    contracts = {
      addKnown: mocks.addKnown,
      getMany: mocks.getMany,
      getLatestVersions: mocks.getLatestVersions,
    };
    identities = { fetch: mocks.fetch };
    stateTransitions = {};
    documents = {}; dpns = {}; tokens = {}; epoch = {}; protocol = {};
    system = {}; voting = {}; group = {}; addresses = {}; shielded = {};
    constructor(public options: unknown) { mocks.instances.push(this); }
  },
  DataContract: { fromBase64: (bytes: string) => ({ bytes }) },
  PlatformVersion: { latest: () => ({}) },
}));
vi.mock('@/lib/contracts/bundled-contracts', () => ({
  bundleKey: () => 'devnet',
  bundledContractsFor: async () => ({
    contracts: {
      contract: { bytes: 'contract-bytes', version: 1 },
      profile: { bytes: 'profile-bytes', version: 1 },
    },
  }),
  staleContractIds: () => [],
}));
vi.mock('@/lib/query-inspector/capture', () => ({ instrumentSdk: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../constants', () => ({
  YAPPR_DM_CONTRACT_ID: '', YAPPR_PROFILE_CONTRACT_ID: 'profile', KEY_EXCHANGE_CONTRACT_ID: '',
  YAPPR_BLOG_CONTRACT_ID: '', YAPPR_STOREFRONT_CONTRACT_ID: '', YAPPR_VAULT_CONTRACT_ID: '',
  YAPPR_AUTH_VAULT_CONTRACT_ID: '', POLLR_CONTRACT_ID: '', TOKEN_HISTORY_CONTRACT_ID: '',
  DAPI_ADDRESSES: [], DEVNET_NAME: 'default-devnet', DEVNET_QUORUM_URL: '',
}));

const config = {
  network: 'devnet' as const,
  contractId: 'contract',
  devnetName: 'configured-devnet',
  addresses: ['https://configured-node.invalid'],
  quorumUrl: 'https://configured-quorums.invalid',
};

const exhausted = () => new Error('no available addresses to use');

beforeEach(() => {
  vi.resetModules();
  mocks.instances.length = 0;
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.addKnown.mockReset().mockResolvedValue(true);
  mocks.getMany.mockReset().mockResolvedValue(new Map());
  mocks.fetch.mockReset().mockResolvedValue({ id: 'identity' });
  // Every instance's background revalidation fails the same way, so a single
  // rebuild would be enough to start an endless rebuild loop.
  mocks.getLatestVersions.mockReset().mockImplementation(async () => { throw exhausted(); });
});

describe('background contract revalidation', () => {
  it('does not trigger recovery when it fails with an exhausted address pool', async () => {
    vi.useFakeTimers();
    try {
      const { evoSdkService } = await import('./evo-sdk-service');
      await evoSdkService.initialize(config);

      // No application read, no online event: only the fire-and-forget
      // revalidation of the seeded bundle is in flight.
      await vi.advanceTimersByTimeAsync(30000);

      expect(mocks.instances).toHaveLength(1);
      expect(mocks.connect).toHaveBeenCalledTimes(1);
      expect(mocks.getLatestVersions).toHaveBeenCalledTimes(1);
      expect(evoSdkService.isReady()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still recovers when an application read fails the same way', async () => {
    vi.useFakeTimers();
    try {
      const { evoSdkService } = await import('./evo-sdk-service');
      await evoSdkService.initialize(config);
      const oldSdk = await evoSdkService.getSdk();

      const addressFailure = exhausted();
      mocks.fetch.mockRejectedValueOnce(addressFailure);
      const failedRead = expect(oldSdk.identities.fetch('identity')).rejects.toBe(addressFailure);
      await vi.advanceTimersByTimeAsync(2000);
      await failedRead;

      // Exactly one rebuild: the read recovered, and neither instance's failed
      // revalidation added a rebuild of its own.
      expect(mocks.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(30000);
      expect(mocks.instances).toHaveLength(2);
      expect(mocks.getLatestVersions).toHaveBeenCalledTimes(2);
      const healthySdk = await evoSdkService.getSdk();
      expect(healthySdk).not.toBe(oldSdk);
      await expect(healthySdk.identities.fetch('identity')).resolves.toEqual({ id: 'identity' });
    } finally {
      vi.useRealTimers();
    }
  });
});
