import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';

const connected = vi.hoisted(() => ({ document: vi.fn(), connect: vi.fn(), decoded: vi.fn((bytes) => ({ bytes })) }));
vi.mock('./sdk-env.mjs', () => ({ connectSdk: connected.connect, keyNetwork: () => 'testnet', devnetName: () => 'sakura' }));
vi.mock('@dashevo/evo-sdk', async (original) => { const actual = await original(); return { ...actual, Document: { fromBytes: connected.document, fromObject: actual.Document.fromObject }, StateTransition: { fromBytes: connected.decoded } }; });
import { assertRegistered, existsStep, importNonceFloors, nextNonce, manifestHash, balancesFor, charterOptions, commitStep, main, validateManifest, watchContract, writeCheckpoint } from './file-release-charters.mjs';
import { APP_CONNECT_ENTRIES, contractFilePath } from './app-connect-set.mjs';

const id = (n) => bs58.encode(new Uint8Array(32).fill(n));
const actor = (n) => ({ identityId: id(n), keyFile: `/missing/actor-${n}.json`, keyId: 1, masterKeyFile: `/missing/actor-${n}.json`, masterKeyId: 0 });
const manifest = () => ({ contract: 'social', targetContractId: id(1), expected: { ownerId: id(6), joinWindow: 3600, voteWindow: 3600, challengeCoolDown: 2592000, documentTypes: ['post', 'reply'], interim: 'notYetUsable' }, leader: actor(2), members: [actor(3), actor(4), actor(5)], reasons: [{ code: 'SPM', label: 'Spam' }], description: 'Release moderation team' });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('charter release safety policy', () => {
  it('requires NETWORK and an explicit, single mode', () => {
    expect(() => charterOptions(['--plan', '--config', 'x'], {})).toThrow('NETWORK');
    expect(() => charterOptions(['--live', '--plan', '--config', 'x'], { NETWORK: 'devnet' })).toThrow('exactly one');
    expect(() => charterOptions(['--liv', '--config', 'x'], { NETWORK: 'devnet' })).toThrow();
  });
  it('refuses mainnet until explicitly allowed, and production broadcasts need both gates', () => {
    expect(() => charterOptions(['--plan', '--config', 'x'], { NETWORK: 'mainnet' })).toThrow('mainnet');
    expect(charterOptions(['--plan', '--allow-mainnet', '--config', 'x'], { NETWORK: 'mainnet' }).mode).toBe('plan');
    expect(() => charterOptions(['--live', '--config', 'x', '--journal', 'j'], { NETWORK: 'testnet' })).toThrow('production');
    expect(() => charterOptions(['--live', '--production', '--config', 'x'], { NETWORK: 'testnet' })).toThrow('journal');
  });
  it('accepts all three contracts, but requires a usable distinct team and valid reward split', () => {
    for (const contract of ['social', 'blog', 'storefront']) expect(validateManifest({ ...manifest(), contract }).contract).toBe(contract);
    expect(() => validateManifest({ ...manifest(), members: [actor(2), actor(3)] })).toThrow('distinct');
    expect(() => validateManifest({ ...manifest(), members: [] })).toThrow('2 to 15');
    expect(() => validateManifest({ ...manifest(), rewardSplit: { leader: 100, equal: 100, actions: 0 } })).toThrow('sum');
    expect(() => validateManifest({ ...manifest(), reasons: [] })).toThrow('reasons');
    expect(() => validateManifest({ ...manifest(), description: '🙂'.repeat(1100) })).toThrow('description');
  });
  it('validates declaration expectations and encrypted message limits before setup', () => {
    expect(() => validateManifest({ ...manifest(), expected: undefined })).toThrow('expected');
    expect(() => validateManifest({ ...manifest(), members: [{ ...actor(3), message: '🙂'.repeat(256) }, actor(4)] })).toThrow('1023 bytes');
    const input = manifest();
    const contract = { ownerId: { toBase58: () => input.expected.ownerId }, config: { moderation: { moderators: { $type: 'elected', ...input.expected, moderatedDocumentTypes: { post: {}, reply: {} }, interim: { $type: 'notYetUsable' } } } } };
    expect(() => assertRegistered(contract, input.expected)).not.toThrow();
    expect(() => assertRegistered(contract, { ...input.expected, voteWindow: 259200 })).toThrow('voteWindow');
    expect(() => assertRegistered(contract, { ...input.expected, ownerId: id(7) })).toThrow('owner');
  });
  it('documents the exact moderated types from the selected registration templates', () => {
    const docs = readFileSync(new URL('../docs/TESTNET_RELEASE.md', import.meta.url), 'utf8');
    const lists = docs.match(/social uses ([^;]+); blog uses ([^;]+); storefront uses ([^.]+)\./);
    expect(lists).not.toBeNull();
    for (const [i, name] of ['social', 'blog', 'storefront'].entries()) {
      const entry = APP_CONNECT_ENTRIES.find((e) => e.name === name);
      const template = JSON.parse(readFileSync(contractFilePath(entry.file), 'utf8'));
      const documented = [...lists[i + 1].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      expect(documented.sort()).toEqual(Object.keys(template.config.moderation.moderators.moderatedDocumentTypes).sort());
    }
  });
  it('binds journal semantics while allowing restored key paths and reordered fields', () => {
    const input = validateManifest(manifest());
    const restored = { ...input, leader: { ...input.leader, keyFile: '/restored/key.json', masterKeyFile: '/restored/master.json' } };
    expect(manifestHash(restored)).toBe(manifestHash(input));
    expect(manifestHash({ ...restored, description: 'Different policy' })).not.toBe(manifestHash(input));
    expect(manifestHash({ ...restored, leader: { ...restored.leader, keyId: 2 } })).not.toBe(manifestHash(input));
  });
  it('checks all actor balances, including the full 0.51 DASH leader reserve', async () => {
    const sdk = { identities: { fetch: vi.fn().mockResolvedValueOnce({ balance: 50_999_999_999n }).mockResolvedValue({ balance: 100_000_000n }) } };
    const result = await balancesFor(sdk, manifest());
    expect(result[0]).toMatchObject({ ready: false, required: '51000000000' });
    expect(result.slice(1).every((b) => b.ready)).toBe(true);
    sdk.identities.fetch.mockResolvedValue(null);
    expect((await balancesFor(sdk, manifest())).every((b) => b.balance === null && !b.ready)).toBe(true);
  });
});

describe('read-only modes', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'charter-plan-')); connected.connect.mockReset(); vi.stubEnv('NETWORK', 'testnet'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const config = (dir) => { const path = join(dir, 'manifest.json'); writeFileSync(path, JSON.stringify(manifest())); return path; };
  it('plans with placeholder identities without connecting or opening nonexistent key files', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--plan', '--config', config(dir)]);
    expect(connected.connect).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ broadcasts: false, keysRead: false });
  });
  it('dry-run reads absent placeholder identities without signing, writing a journal or broadcasting', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sdk = { epoch: { current: vi.fn().mockResolvedValue({ protocolVersion: 14 }) }, identities: { fetch: vi.fn().mockResolvedValue(null) }, contracts: { fetch: vi.fn().mockResolvedValue(null) }, stateTransitions: { broadcastAndWait: vi.fn() } };
    connected.connect.mockResolvedValue(sdk);
    await main(['--dry-run', '--config', config(dir)]);
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls.at(-1)[0])).toMatchObject({ ready: false, broadcasts: false, keysRead: false });
  });
  it('refuses unprepared filing before connecting or opening actor keys', async () => {
    vi.stubEnv('NETWORK', 'devnet');
    await expect(main(['--live', '--config', config(dir), '--journal', join(dir, 'missing.json')])).rejects.toThrow('prepared journal required');
    expect(connected.connect).not.toHaveBeenCalled();
  });
  it('proves a landed but unverified application before balance gates or signing keys', async () => {
    vi.stubEnv('NETWORK', 'devnet');
    const input = validateManifest(manifest()), path = join(dir, 'journal.json');
    writeCheckpoint(path, { network: 'devnet', devnet: 'sakura', configHash: manifestHash(input), targetContractId: input.targetContractId,
      keys: {}, steps: { application: { id: id(8), owner: input.leader.identityId, type: 'electedCharter', state: 'broadcasting' } } });
    const application = { id: { toBase58: () => id(8) }, ownerId: { toBase58: () => input.leader.identityId }, free: vi.fn() };
    connected.document.mockReturnValue(application);
    const sdk = { epoch: { current: vi.fn().mockResolvedValue({ protocolVersion: 14 }) },
      identities: { fetch: vi.fn() }, contracts: { fetch: vi.fn().mockResolvedValue({ free: vi.fn() }) },
      voting: { contestedResourceVoteState: vi.fn().mockResolvedValue({ contenders: [{ identityId: application.ownerId, serializedDocument: new Uint8Array([1]) }], free: vi.fn() }) },
      stateTransitions: { broadcastAndWait: vi.fn() } };
    connected.connect.mockResolvedValue(sdk);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--live', '--config', config(dir), '--journal', path]);
    expect(JSON.parse(readFileSync(path)).steps.application.state).toBe('verified');
    expect(sdk.identities.fetch).not.toHaveBeenCalled();
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled();
  });
  it('does not wait for an application that was prepared but never broadcast', async () => {
    vi.stubEnv('NETWORK', 'devnet'); vi.useFakeTimers();
    const input = validateManifest(manifest()), path = join(dir, 'journal.json');
    writeCheckpoint(path, { network: 'devnet', devnet: 'sakura', configHash: manifestHash(input), targetContractId: input.targetContractId,
      prepared: true, keys: {}, steps: { application: { id: id(8), owner: input.leader.identityId, type: 'electedCharter', state: 'prepared' } } });
    const sdk = { epoch: { current: vi.fn().mockResolvedValue({ protocolVersion: 14 }) }, identities: { fetch: vi.fn().mockResolvedValue(null) },
      moderationCharters: { seatedCharter: vi.fn().mockResolvedValue(null) },
      voting: { contestedResourceVoteState: vi.fn().mockResolvedValue({ contenders: [], free: vi.fn() }) } };
    connected.connect.mockResolvedValue(sdk); vi.spyOn(console, 'log').mockImplementation(() => {});
    const start = Date.now();
    await expect(main(['--live', '--config', config(dir), '--journal', path])).rejects.toThrow('insufficient balance');
    expect(Date.now()).toBe(start);
    expect(sdk.voting.contestedResourceVoteState).toHaveBeenCalledOnce();
  });
  it('writes owner-only checkpoints and refuses an existing public file', () => {
    const path = join(dir, 'journal.json');
    writeCheckpoint(path, { test: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path))).toEqual({ test: true });
    const publicPath = join(dir, 'public.json'); writeFileSync(publicPath, '{}', { mode: 0o644 });
    expect(() => writeCheckpoint(publicPath, {})).toThrow('group or other');
  });
});

describe('journaled create recovery', () => {
  const step = () => ({ id: id(8), type: 'submittedCharter', owner: id(2), bytes: Buffer.from('same signed bytes').toString('base64'), state: 'prepared' });
  const sdkFor = () => ({ documents: { get: vi.fn() }, system: { status: vi.fn().mockResolvedValue({ toJSON: () => ({ chain: { latestBlockHeight: '10' } }), free: vi.fn() }) }, stateTransitions: { broadcastAndWait: vi.fn() } });
  it('carries a proved actor nonce across two sequential target journals and persists it for resume', async () => {
    vi.useFakeTimers();
    const prior = { network: 'devnet', devnet: 'sakura', targetContractId: id(1), configHash: 'a'.repeat(64), keys: {},
      steps: { application: { type: 'electedCharter', owner: id(2), nonce: '8', state: 'verified' } } };
    const state = { network: 'devnet', devnet: 'sakura', targetContractId: id(9), steps: { reusedReason: { type: 'reason', owner: id(2), state: 'verified' } } };
    importNonceFloors(state, prior);
    const restored = JSON.parse(JSON.stringify(state));
    const sdk = { wasm: { getIdentityContractNonce: vi.fn().mockResolvedValueOnce(7n).mockResolvedValue(8n) } };
    const pending = nextNonce(sdk, restored, id(2));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(9n);
    expect(restored.nonceFloors).toEqual({ [id(2)]: '8' });
    importNonceFloors(restored, { ...prior, steps: {}, nonceFloorsContractId: 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88', nonceFloors: { [id(2)]: '6' } });
    expect(restored.nonceFloors[id(2)]).toBe('8');
  });
  it('rejects prior journals from other networks, devnets, contracts or unresolved writes', () => {
    const state = { network: 'devnet', devnet: 'sakura', steps: {} };
    const prior = { ...state, targetContractId: id(1), configHash: 'a'.repeat(64), keys: {}, steps: {} };
    expect(() => importNonceFloors(state, { ...prior, network: 'testnet' })).toThrow('network/devnet');
    expect(() => importNonceFloors(state, { ...prior, devnet: 'other' })).toThrow('network/devnet');
    expect(() => importNonceFloors(state, { ...prior, steps: { proposal: { type: 'submittedCharter', state: 'broadcasting' } } })).toThrow('unresolved');
    expect(() => importNonceFloors(state, { ...prior, nonceFloorsContractId: id(7), nonceFloors: {} })).toThrow('another contract');
    expect(() => importNonceFloors(state, { ...prior, steps: { document: { type: 'post', state: 'verified' } } })).toThrow('charters contract');
    expect(() => importNonceFloors(state, { ...prior, nonceFloorsContractId: 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88', nonceFloors: { [id(2)]: '-1' } })).toThrow('nonce floor');
  });
  it('waits for a nonce read to catch up with the preceding proved write by this actor', async () => {
    vi.useFakeTimers();
    const sdk = { wasm: { getIdentityContractNonce: vi.fn().mockResolvedValueOnce(4n).mockResolvedValueOnce(4n).mockResolvedValue(5n) } };
    const state = { steps: { reason: { owner: id(2), nonce: '5', state: 'verified' },
      otherActor: { owner: id(3), nonce: '90', state: 'verified' }, uncertain: { owner: id(2), nonce: '80', state: 'broadcasting' } } };
    const pending = nextNonce(sdk, state, id(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe(6n);
    expect(sdk.wasm.getIdentityContractNonce).toHaveBeenCalledTimes(3);
  });
  it('never checkpoints or broadcasts a new step if nonce reads stay below the proved floor', async () => {
    vi.useFakeTimers();
    const sdk = sdkFor(), state = { targetContractId: id(1), steps: { reason: { owner: id(2), nonce: '5', state: 'verified' } } }, save = vi.fn();
    sdk.wasm = { getIdentityContractNonce: vi.fn().mockResolvedValue(4n) };
    const pending = expect(commitStep(sdk, state, 'proposal', save, async () => ({ ...step(), nonce: String(await nextNonce(sdk, state, id(2))) }))).rejects.toThrow('no new transition prepared');
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    expect(state.steps.proposal).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled();
  });
  it('proves an application beyond the first contender page by querying its owner directly', async () => {
    const owner = id(250), documentId = id(8);
    const application = { id: { toBase58: () => documentId }, ownerId: { toBase58: () => owner }, free: vi.fn() };
    connected.document.mockReturnValue(application);
    const earlier = Array.from({ length: 100 }, (_, i) => ({ identityId: { toBase58: () => id(i + 1) } }));
    const sdk = { contracts: { fetch: vi.fn().mockResolvedValue({ free: vi.fn() }) }, moderationCharters: { seatedCharter: vi.fn().mockResolvedValue(null) },
      voting: { contestedResourceVoteState: vi.fn().mockImplementation(async (query) => ({ contenders: query.startAtContenderId === owner && query.startAtIncluded && query.limit === 1
        ? [{ identityId: application.ownerId, serializedDocument: new Uint8Array([1]) }] : earlier, free: vi.fn() })) } };
    expect(await existsStep(sdk, { id: documentId, owner, type: 'electedCharter' }, id(1))).toBe(true);
    expect(sdk.voting.contestedResourceVoteState).toHaveBeenCalledWith(expect.objectContaining({ startAtContenderId: owner, startAtIncluded: true, limit: 1 }));
  });
  it('checkpoints signed bytes before broadcast and proves success even when the wait throws', async () => {
    const sdk = sdkFor(), state = { targetContractId: id(1), steps: {} }, saved = [];
    sdk.documents.get.mockResolvedValueOnce(null).mockResolvedValueOnce({});
    sdk.stateTransitions.broadcastAndWait.mockImplementation(async () => {
      expect(saved.at(-1).steps.proposal.state).toBe('broadcasting');
      expect(saved.at(-1).steps.proposal.bytes).toBe(step().bytes);
      throw new Error('timeout');
    });
    const result = await commitStep(sdk, state, 'proposal', () => saved.push(structuredClone(state)), async () => step());
    expect(result.state).toBe('verified');
    expect(sdk.stateTransitions.broadcastAndWait).toHaveBeenCalledTimes(1);
  });
  it('resumes an ambiguous result using the same bytes and never a fresh nonce', async () => {
    const sdk = sdkFor(), original = { ...step(), state: 'broadcasting' }, state = { targetContractId: id(1), steps: { proposal: original } }, make = vi.fn();
    sdk.documents.get.mockResolvedValueOnce(null).mockResolvedValueOnce({});
    await commitStep(sdk, state, 'proposal', () => {}, make);
    expect(make).not.toHaveBeenCalled();
    expect(connected.decoded).toHaveBeenLastCalledWith(Buffer.from(original.bytes, 'base64'));
  });
  it('does not broadcast or prepare again if proved state already contains the document', async () => {
    const sdk = sdkFor(), state = { targetContractId: id(1), steps: { proposal: step() } }, make = vi.fn();
    sdk.documents.get.mockResolvedValue({});
    await commitStep(sdk, state, 'proposal', () => {}, make);
    expect(make).not.toHaveBeenCalled(); expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled();
  });
  it('waits for lagging proof instead of rebroadcasting a consumed nonce', async () => {
    vi.useFakeTimers();
    const sdk = sdkFor(), original = { ...step(), nonce: '2', state: 'broadcasting' }, state = { targetContractId: id(1), steps: { proposal: original } };
    sdk.wasm = { getIdentityContractNonce: vi.fn().mockResolvedValue(2n) };
    sdk.documents.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({});
    const pending = commitStep(sdk, state, 'proposal', () => {}, vi.fn());
    await vi.advanceTimersByTimeAsync(5000); await pending;
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled();
    expect(original.state).toBe('verified');
  });
  it('stops a consumed nonce without telling the operator to replace uncertain bytes', async () => {
    vi.useFakeTimers();
    const sdk = sdkFor(), original = { ...step(), nonce: '2', state: 'broadcasting' }, state = { targetContractId: id(1), steps: { proposal: original } };
    sdk.wasm = { getIdentityContractNonce: vi.fn().mockResolvedValue(2n) };
    sdk.documents.get.mockResolvedValue(null);
    const failure = expect(commitStep(sdk, state, 'proposal', () => {}, vi.fn())).rejects.toThrow('reconcile the saved transition');
    await vi.advanceTimersByTimeAsync(60_000); await failure;
    expect(sdk.stateTransitions.broadcastAndWait).not.toHaveBeenCalled();
    expect(original.bytes).toBe(step().bytes);
  });
  it('rejects a different elected document from the same leader as proof of this application', async () => {
    const application = { id: { toBase58: () => id(9) }, ownerId: { toBase58: () => id(2) }, free: vi.fn() };
    connected.document.mockReturnValue(application);
    const sdk = { contracts: { fetch: vi.fn().mockResolvedValue({ free: vi.fn() }) }, voting: { contestedResourceVoteState: vi.fn().mockResolvedValue({ contenders: [{ identityId: application.ownerId, serializedDocument: new Uint8Array([1]) }], free: vi.fn() }) } };
    expect(await existsStep(sdk, { id: id(8), owner: id(2), type: 'electedCharter' }, id(1))).toBe(false);
    expect(application.free).toHaveBeenCalled();
  });
  it('stops with the journal intact when neither broadcast nor proof succeeds', async () => {
    const sdk = sdkFor(), state = { targetContractId: id(1), steps: {} };
    sdk.documents.get.mockResolvedValue(null); sdk.stateTransitions.broadcastAndWait.mockRejectedValue(new Error('unavailable'));
    vi.useFakeTimers();
    const failure = expect(commitStep(sdk, state, 'proposal', () => {}, async () => step())).rejects.toThrow('retain the journal');
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    expect(sdk.documents.get).toHaveBeenCalledTimes(14);
    expect(state.steps.proposal.bytes).toBe(step().bytes); expect(state.steps.proposal.state).toBe('broadcasting');
  }, 10000);
});


describe('read-only seated election watch', () => {
  it.each([['joining', 0], ['voting', 2_000_000]])('bounds a contested %s phase search by chain time and registered windows', async (phase, offset) => {
    const now = 1792266000000 + offset, end = 1792271000000;
    const asId = (value) => ({ toBase58: () => value });
    const sdk = {
      contracts: { fetch: vi.fn().mockResolvedValue({ config: { moderation: { moderators: { $type: 'elected', joinWindow: 3600, voteWindow: 3600, interim: { $type: 'notYetUsable' } } } }, free: vi.fn() }) },
      moderationCharters: { submittedCharters: vi.fn().mockResolvedValue(new Map()), team: vi.fn().mockResolvedValue(null) },
      voting: { contestedResourceVoteState: vi.fn().mockResolvedValue({ contenders: [{ identityId: asId(id(2)), voteTally: 4 }, { identityId: asId(id(6)), voteTally: 0 }], free: vi.fn() }),
        votePollsByEndDate: vi.fn().mockResolvedValue([{ timestampMs: BigInt(end), votePolls: [{ toJSON: () => ({ contractId: 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88', documentTypeName: 'electedCharter', indexName: 'byTargetContract', indexValues: [id(1)] }) }], free: vi.fn() }]) },
      system: { status: vi.fn().mockResolvedValue({ toJSON: () => ({ time: { block: String(now) }, chain: { latestBlockHeight: '30000' } }), free: vi.fn() }) },
    };
    expect(await watchContract(sdk, 'blog', id(1))).toMatchObject({ phase, joinClosesAtMs: end - 3600000, endsAtMs: end });
    expect(sdk.voting.votePollsByEndDate).toHaveBeenCalledWith(expect.objectContaining({ startTimeMs: BigInt(now), endTimeMs: now + 7200000 + 600000 }));
  });
  it('maps the real ModerationTeam getters without relying on a toJSON method', async () => {
    const asId = (value) => ({ toBase58: () => value });
    const team = { electedCharterId: asId(id(8)), submittedCharterId: asId(id(7)), leaderId: asId(id(2)), members: [asId(id(3))], free: vi.fn() };
    const sdk = {
      contracts: { fetch: vi.fn().mockResolvedValue({ config: { moderation: { moderators: { $type: 'elected', joinWindow: 3600, voteWindow: 3600, interim: { $type: 'notYetUsable' } } } }, free: vi.fn() }) },
      moderationCharters: { submittedCharters: vi.fn().mockResolvedValue(new Map()), team: vi.fn().mockResolvedValue(team) },
      voting: { contestedResourceVoteState: vi.fn().mockResolvedValue({ contenders: [], winner: { kind: 'WonByIdentity', identityId: asId(id(2)), block: { height: 30000n, timeMs: 1792273000000n } }, free: vi.fn() }), votePollsByEndDate: vi.fn().mockResolvedValue([]) },
      system: { status: vi.fn().mockResolvedValue({ toJSON: () => ({ time: { block: '1792273000000' }, chain: { latestBlockHeight: '30000' } }), free: vi.fn() }) },
    };
    const result = await watchContract(sdk, 'social', id(1));
    expect(result).toMatchObject({ phase: 'seated', team: { leaderId: id(2), members: [id(3)], electedCharterId: id(8) } });
    expect(team.free).toHaveBeenCalledOnce();
  });
});
