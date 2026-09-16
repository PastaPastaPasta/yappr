import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  instances: [] as { options: unknown }[],
}));
vi.mock('@dashevo/evo-sdk', () => ({
  EvoSDK: class {
    connect = mocks.connect;
    contracts = { getMany: async () => new Map([['contract', {}]]) };
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
});
