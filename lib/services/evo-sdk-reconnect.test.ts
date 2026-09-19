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

async function service() {
  const { evoSdkService } = await import('./evo-sdk-service');
  return evoSdkService;
}

/** Let the observer's rejection handler and the rebuild it starts run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.instances.length = 0;
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.broadcast.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockResolvedValue({ id: 'identity' });
});

describe('connection recovery', () => {
  it('rejects the failed call immediately and rebuilds in the background with the same options', async () => {
    const sdkService = await service();
    await sdkService.initialize(config);
    const oldSdk = await sdkService.getSdk();
    let finishConnect: () => void = () => { throw new Error('connect has not started'); };
    mocks.connect.mockImplementationOnce(() => new Promise<void>(resolve => { finishConnect = resolve; }));
    const failure = exhausted();
    mocks.fetch.mockRejectedValueOnce(failure);

    // The failing read does not wait for the replacement.
    await expect(oldSdk.identities.fetch('identity')).rejects.toBe(failure);
    await settle();
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    let readFinished = false;
    const pendingRead = sdkService.getSdk().then(sdk => { readFinished = true; return sdk; });
    await settle();
    expect(readFinished).toBe(false);
    finishConnect();
    const healthySdk = await pendingRead;
    expect(healthySdk).not.toBe(oldSdk);
    expect(healthySdk).toBe(await sdkService.getSdk());
    expect(mocks.instances[1].options).toEqual(mocks.instances[0].options);
    expect(mocks.instances[1].options).toMatchObject({
      network: config.network, devnetName: config.devnetName,
      addresses: config.addresses, quorumUrl: config.quorumUrl,
    });
    expect(sdkService.isReady()).toBe(true);
  });

  it('shares one rebuild between a failed write, a failed read and an online event, and replays nothing', async () => {
    const sdkService = await service();
    await sdkService.initialize(config);
    const oldSdk = await sdkService.getSdk();
    const failure = exhausted();
    mocks.broadcast.mockRejectedValueOnce(failure);
    mocks.fetch.mockRejectedValueOnce(failure);
    const transition = {} as Parameters<typeof oldSdk.stateTransitions.broadcastStateTransition>[0];
    await expect(oldSdk.stateTransitions.broadcastStateTransition(transition)).rejects.toBe(failure);
    await expect(oldSdk.identities.fetch('identity')).rejects.toBe(failure);
    const restored = sdkService.restoreConnection();
    await settle();
    await restored;

    expect(mocks.instances).toHaveLength(2);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const healthySdk = await sdkService.getSdk();
    expect(healthySdk).not.toBe(oldSdk);
    await healthySdk.stateTransitions.broadcastStateTransition(transition);
    expect(mocks.broadcast).toHaveBeenLastCalledWith(transition);
  });

  it('spaces rebuilds apart while every call keeps failing', async () => {
    const sdkService = await service();
    await sdkService.initialize(config);
    mocks.fetch.mockRejectedValue(exhausted());
    await expect((await sdkService.getSdk()).identities.fetch('a')).rejects.toThrow();
    await settle();
    expect(mocks.instances).toHaveLength(2);

    await expect((await sdkService.getSdk()).identities.fetch('b')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.instances).toHaveLength(3);
    expect(mocks.instances[2].options).toEqual(mocks.instances[0].options);
  });

  it('ignores validation errors and late failures from a replaced instance', async () => {
    const sdkService = await service();
    await sdkService.initialize(config);
    const oldSdk = await sdkService.getSdk();
    const invalid = new Error('Invalid document schema');
    mocks.broadcast.mockRejectedValueOnce(invalid);
    const transition = {} as Parameters<typeof oldSdk.stateTransitions.broadcastStateTransition>[0];
    await expect(oldSdk.stateTransitions.broadcastStateTransition(transition)).rejects.toBe(invalid);
    await settle();
    expect(mocks.instances).toHaveLength(1);

    let fail: (error: Error) => void = () => { throw new Error('query has not started'); };
    mocks.fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const lateRead = oldSdk.identities.fetch('identity');
    await sdkService.reconnect();
    const healthySdk = await sdkService.getSdk();
    fail(exhausted());
    await expect(lateRead).rejects.toThrow();
    await settle();
    expect(mocks.instances).toHaveLength(2);
    expect(await sdkService.getSdk()).toBe(healthySdk);
  });
});

describe('restoreConnection', () => {
  it('does not treat an instance built after a failed rebuild as lost', async () => {
    const sdkService = await service();
    await sdkService.initialize(config);
    mocks.fetch.mockRejectedValueOnce(exhausted());
    mocks.connect.mockRejectedValueOnce(new Error('still offline'));
    await expect((await sdkService.getSdk()).identities.fetch('identity')).rejects.toThrow();
    await settle();
    expect(mocks.instances).toHaveLength(2);
    expect(sdkService.isReady()).toBe(false);

    // The next reader gets its own attempt, not the failed rebuild's error.
    const healthySdk = await sdkService.getSdk();
    expect(mocks.instances).toHaveLength(3);
    expect(sdkService.isReady()).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    await sdkService.restoreConnection();
    expect(mocks.instances).toHaveLength(3);
    expect(await sdkService.getSdk()).toBe(healthySdk);
  });

  it('gives a reader parked behind a failing rebuild its own attempt', async () => {
    const sdkService = await service();
    await sdkService.initialize(config);
    let failConnect: (error: Error) => void = () => { throw new Error('connect has not started'); };
    mocks.connect.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failConnect = reject; }));
    mocks.fetch.mockRejectedValueOnce(exhausted());
    await expect((await sdkService.getSdk()).identities.fetch('identity')).rejects.toThrow();
    await settle();
    expect(mocks.instances).toHaveLength(2);

    const parked = sdkService.getSdk();
    failConnect(new Error('still offline'));
    const sdk = await parked;
    expect(mocks.instances).toHaveLength(3);
    expect(sdk).toBe(await sdkService.getSdk());
    expect(sdkService.isReady()).toBe(true);
  });

  it('leaves a healthy instance alone', async () => {
    const sdkService = await service();
    await sdkService.initialize(config);
    const sdk = await sdkService.getSdk();
    await sdkService.restoreConnection();
    expect(mocks.instances).toHaveLength(1);
    expect(await sdkService.getSdk()).toBe(sdk);
  });

  it('retries a bootstrap that failed offline, then rebuilds again after a later exhaustion', async () => {
    const sdkService = await service();
    mocks.connect.mockRejectedValueOnce(new Error('offline'));
    await expect(sdkService.initialize(config)).rejects.toThrow('offline');
    expect(sdkService.isReady()).toBe(false);

    await sdkService.restoreConnection();
    expect(sdkService.isReady()).toBe(true);
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[1].options).toEqual(mocks.instances[0].options);

    mocks.fetch.mockRejectedValueOnce(exhausted());
    mocks.connect.mockRejectedValueOnce(new Error('still offline'));
    await expect((await sdkService.getSdk()).identities.fetch('identity')).rejects.toThrow();
    await settle();
    expect(sdkService.isReady()).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    await sdkService.restoreConnection();
    expect(sdkService.isReady()).toBe(true);
    expect(mocks.instances).toHaveLength(4);
    await expect((await sdkService.getSdk()).identities.fetch('identity')).resolves.toEqual({ id: 'identity' });
  });

  it('lets an in-flight offline bootstrap fail, then starts a fresh one', async () => {
    const sdkService = await service();
    let fail: (error: Error) => void = () => { throw new Error('connect has not started'); };
    mocks.connect.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const initial = sdkService.initialize(config);
    const restored = sdkService.restoreConnection();
    expect(mocks.instances).toHaveLength(1);
    const offline = new Error('offline initialization');
    fail(offline);
    await expect(initial).rejects.toBe(offline);
    await restored;
    expect(mocks.instances).toHaveLength(2);
    expect(sdkService.isReady()).toBe(true);
  });
});
