import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  broadcast: vi.fn(),
  fetch: vi.fn(),
  instances: [] as { options: unknown }[],
}));
vi.mock('@dashevo/evo-sdk', () => ({
  EvoSDK: class {
    connect = mocks.connect;
    contracts = { getMany: async () => new Map([['contract', {}]]) };
    identities = { fetch: mocks.fetch };
    stateTransitions = { broadcastStateTransition: mocks.broadcast };
    documents = {}; dpns = {}; tokens = {}; epoch = {}; protocol = {};
    system = {}; voting = {}; group = {}; addresses = {}; shielded = {};
    constructor(public options: unknown) { mocks.instances.push(this); }
  },
  DataContract: {},
  PlatformVersion: {},
}));
vi.mock('@/lib/contracts/bundled-contracts', () => ({
  bundleKey: () => 'devnet',
  bundledContractsFor: async () => undefined,
  staleContractIds: () => [],
}));
vi.mock('@/lib/query-inspector/capture', () => ({ instrumentSdk: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../constants', () => ({
  YAPPR_DM_CONTRACT_ID: '', YAPPR_PROFILE_CONTRACT_ID: '', KEY_EXCHANGE_CONTRACT_ID: '',
  YAPPR_BLOG_CONTRACT_ID: '', YAPPR_STOREFRONT_CONTRACT_ID: '', YAPPR_VAULT_CONTRACT_ID: '',
  YAPPR_AUTH_VAULT_CONTRACT_ID: '', POLLR_CONTRACT_ID: '',
  DAPI_ADDRESSES: [], DEVNET_NAME: 'default-devnet', DEVNET_QUORUM_URL: '',
}));

const config = {
  network: 'devnet' as const,
  contractId: 'contract',
  devnetName: 'configured-devnet',
  addresses: ['https://configured-node.invalid'],
  quorumUrl: 'https://configured-quorums.invalid',
};

beforeEach(() => {
  vi.resetModules();
  mocks.instances.length = 0;
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.broadcast.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockResolvedValue({ id: 'identity' });
});

describe('SDK connection recovery', () => {
  it('replaces an exhausted instance, preserves configuration, and shares recovery with concurrent readers', async () => {
    const { evoSdkService } = await import('./evo-sdk-service');
    await evoSdkService.initialize(config);
    const oldSdk = await evoSdkService.getSdk();
    let finish: () => void = () => { throw new Error('connection has not started'); };
    mocks.connect.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));

    const recovery = evoSdkService.reconnect();
    const concurrentRecovery = evoSdkService.reconnect();
    let readFinished = false;
    const pendingRead = evoSdkService.getSdk().then(sdk => { readFinished = true; return sdk; });
    await Promise.resolve();
    expect(readFinished).toBe(false);
    expect(mocks.instances).toHaveLength(2);
    finish();
    await Promise.all([recovery, concurrentRecovery]);
    expect(await pendingRead).not.toBe(oldSdk);
    expect(await pendingRead).toBe(await evoSdkService.getSdk());
    expect(mocks.instances[1].options).toEqual(mocks.instances[0].options);
    expect(mocks.instances[1].options).toMatchObject({
      network: config.network, devnetName: config.devnetName,
      addresses: config.addresses, quorumUrl: config.quorumUrl,
    });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(evoSdkService.isReady()).toBe(true);
  });

  it('can recover again after a failed reconnect without losing configuration', async () => {
    const { evoSdkService } = await import('./evo-sdk-service');
    await evoSdkService.initialize(config);
    const offline = new Error('still offline');
    mocks.connect.mockRejectedValueOnce(offline);
    await expect(evoSdkService.reconnect()).rejects.toBe(offline);
    expect(evoSdkService.isReady()).toBe(false);
    await evoSdkService.reconnect();
    expect(evoSdkService.isReady()).toBe(true);
    expect(mocks.instances).toHaveLength(3);
    expect(mocks.instances[2].options).toEqual(mocks.instances[0].options);
  });

  it('waits for an offline initialization to settle before starting recovery', async () => {
    const { evoSdkService } = await import('./evo-sdk-service');
    let fail: (error: Error) => void = () => { throw new Error('connection has not started'); };
    mocks.connect.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const initial = evoSdkService.initialize(config);
    const recovery = evoSdkService.reconnect();
    const pendingRead = evoSdkService.getSdk();
    const offline = new Error('offline initialization');
    const rejectedInitial = expect(initial).rejects.toBe(offline);
    expect(mocks.instances).toHaveLength(1);
    fail(offline);
    await rejectedInitial;
    await recovery;
    expect(await pendingRead).toBe(await evoSdkService.getSdk());
    expect(mocks.instances).toHaveLength(2);
    expect(evoSdkService.isReady()).toBe(true);
  });

  it('shares error-triggered recovery and its backoff with an online event and readers', async () => {
    vi.useFakeTimers();
    try {
      const { evoSdkService } = await import('./evo-sdk-service');
      await evoSdkService.initialize(config);
      const oldSdk = await evoSdkService.getSdk();
      const errorRecovery = evoSdkService.handleConnectionError(new Error('no available addresses'));
      const onlineRecovery = evoSdkService.reconnect();
      let readFinished = false;
      const pendingRead = evoSdkService.getSdk().then(sdk => { readFinished = true; return sdk; });

      await vi.advanceTimersByTimeAsync(1999);
      expect(readFinished).toBe(false);
      expect(mocks.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await errorRecovery).toBe(true);
      await onlineRecovery;
      expect(await pendingRead).not.toBe(oldSdk);
      expect(mocks.instances).toHaveLength(2);
      expect(mocks.instances[1].options).toEqual(mocks.instances[0].options);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a failed broadcast, shares recovery with a failed query, and only broadcasts again on explicit retry', async () => {
    vi.useFakeTimers();
    try {
      const { evoSdkService } = await import('./evo-sdk-service');
      await evoSdkService.initialize(config);
      const oldSdk = await evoSdkService.getSdk();
      const exhausted = new Error('no available addresses to use');
      mocks.broadcast.mockRejectedValueOnce(exhausted);
      mocks.fetch.mockRejectedValueOnce(exhausted);
      const transition = {} as Parameters<typeof oldSdk.stateTransitions.broadcastStateTransition>[0];
      const failedWrite = expect(oldSdk.stateTransitions.broadcastStateTransition(transition)).rejects.toBe(exhausted);
      const failedRead = expect(oldSdk.identities.fetch('identity')).rejects.toBe(exhausted);
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.all([failedWrite, failedRead]);

      expect(mocks.instances).toHaveLength(2);
      expect(mocks.broadcast).toHaveBeenCalledTimes(1);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const healthySdk = await evoSdkService.getSdk();
      expect(healthySdk).not.toBe(oldSdk);
      await healthySdk.stateTransitions.broadcastStateTransition(transition);
      expect(mocks.broadcast).toHaveBeenCalledTimes(2);
      expect(mocks.broadcast).toHaveBeenLastCalledWith(transition);
      await expect(healthySdk.identities.fetch('identity')).resolves.toEqual({ id: 'identity' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a query-only address failure without an online event', async () => {
    vi.useFakeTimers();
    try {
      const { evoSdkService } = await import('./evo-sdk-service');
      await evoSdkService.initialize(config);
      const oldSdk = await evoSdkService.getSdk();
      const exhausted = new Error('NoAvailableAddressesForRetry');
      mocks.fetch.mockRejectedValueOnce(exhausted);
      const failedRead = expect(oldSdk.identities.fetch('identity')).rejects.toBe(exhausted);
      await vi.advanceTimersByTimeAsync(2000);
      await failedRead;
      expect(mocks.instances).toHaveLength(2);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const healthySdk = await evoSdkService.getSdk();
      await expect(healthySdk.identities.fetch('identity')).resolves.toEqual({ id: 'identity' });
      expect(mocks.broadcast).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rebuild on validation errors or late failures from a replaced SDK', async () => {
    const { evoSdkService } = await import('./evo-sdk-service');
    await evoSdkService.initialize(config);
    const oldSdk = await evoSdkService.getSdk();
    const invalid = new Error('Invalid document schema');
    mocks.broadcast.mockRejectedValueOnce(invalid);
    const transition = {} as Parameters<typeof oldSdk.stateTransitions.broadcastStateTransition>[0];
    await expect(oldSdk.stateTransitions.broadcastStateTransition(transition)).rejects.toBe(invalid);
    expect(mocks.instances).toHaveLength(1);

    let fail: (error: Error) => void = () => { throw new Error('query has not started'); };
    mocks.fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const exhausted = new Error('no available addresses to use');
    const lateRead = expect(oldSdk.identities.fetch('identity')).rejects.toBe(exhausted);
    await evoSdkService.reconnect();
    const healthySdk = await evoSdkService.getSdk();
    fail(exhausted);
    await lateRead;
    expect(mocks.instances).toHaveLength(2);
    expect(await evoSdkService.getSdk()).toBe(healthySdk);
  });
});
