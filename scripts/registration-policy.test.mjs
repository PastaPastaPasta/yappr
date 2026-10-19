import { describe, expect, it } from 'vitest';
import {
  balanceGate, createCostEstimate, directoryProblem, electionWindowProblems, formatCredits, keyFileProblem,
  parseElectionDelay, parseElectionWindows, registrationFee, registrationPolicy, requireNetwork, withElectionDelay, withElectionWindows,
} from './registration-policy.mjs';

const MAKER = 'hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A';
const TESTNET = { network: 'testnet', maker: MAKER, interim: 'notYetUsable', electionWindows: '3600,3600', electionDelay: '3600' };
const stat = (mode, { file = true, uid = 501 } = {}) => ({ isFile: () => file, isDirectory: () => !file, mode, uid });

describe('requireNetwork', () => {
  it('has no default', () => {
    expect(() => requireNetwork(undefined)).toThrow(/NETWORK is not set/);
    expect(() => requireNetwork('  ')).toThrow(/NETWORK is not set/);
  });
  it('takes the three networks and nothing else', () => {
    expect(requireNetwork(' devnet ')).toBe('devnet');
    expect(requireNetwork('testnet')).toBe('testnet');
    expect(requireNetwork('mainnet')).toBe('mainnet');
    expect(() => requireNetwork('regtest')).toThrow(/testnet, mainnet or devnet/);
  });
});

describe('election windows', () => {
  it('parses a nonnegative election delay', () => {
    expect(parseElectionDelay('3600')).toBe(3600);
    expect(parseElectionDelay(' 604800 ')).toBe(604800);
    expect(parseElectionDelay('-1')).toBeNull();
    expect(parseElectionDelay('1h')).toBeNull();
  });
  it('parses <join>,<vote> seconds', () => {
    expect(parseElectionWindows('3600,3600')).toEqual({ joinWindow: 3600, voteWindow: 3600 });
    expect(parseElectionWindows(' 604800 , 259200 ')).toEqual({ joinWindow: 604800, voteWindow: 259200 });
    for (const bad of ['3600', '3600,', '-1,3600', '1h,1h', '3600,3600,3600', '']) expect(parseElectionWindows(bad)).toBeNull();
  });
  it('allows any window up to four weeks off mainnet', () => {
    expect(electionWindowProblems({ joinWindow: 0, voteWindow: 3600 }, 'testnet')).toEqual([]);
    expect(electionWindowProblems({ joinWindow: 2_419_201, voteWindow: 3600 }, 'testnet')).toHaveLength(1);
  });
  it('refuses windows under a day on mainnet', () => {
    expect(electionWindowProblems({ joinWindow: 3600, voteWindow: 3600 }, 'mainnet')).toHaveLength(2);
    expect(electionWindowProblems({ joinWindow: 86_400, voteWindow: 259_200 }, 'mainnet')).toEqual([]);
  });
  it('renders into an elected declaration only', () => {
    const elected = { moderation: { banlist: true, moderators: { $type: 'elected', joinWindow: 604800, voteWindow: 259200, interim: { $type: 'contractOwner' } } } };
    const rendered = withElectionWindows(elected, { joinWindow: 3600, voteWindow: 3600 });
    expect(rendered.moderation.moderators).toEqual({ $type: 'elected', joinWindow: 3600, voteWindow: 3600, interim: { $type: 'contractOwner' } });
    expect(rendered.moderation.banlist).toBe(true);
    expect(elected.moderation.moderators.joinWindow).toBe(604800);
    const appointed = { moderation: { moderators: { $type: 'appointedModerators', identities: [] } } };
    expect(withElectionWindows(appointed, { joinWindow: 1, voteWindow: 1 })).toBe(appointed);
    expect(withElectionWindows(elected, null)).toBe(elected);
    expect(withElectionDelay(elected, 3600).moderation.moderators.electionDelay).toBe(3600);
  });
});

describe('registrationPolicy', () => {
  it('requires the interim, the windows and the maker off devnet', () => {
    expect(() => registrationPolicy({ network: 'testnet', mode: 'plan' })).toThrow(/--maker[\s\S]*--interim[\s\S]*--election-windows/);
    expect(() => registrationPolicy({ ...TESTNET, interim: null, mode: 'dry-run' })).toThrow(/--interim <kind> is required on testnet/);
    expect(() => registrationPolicy({ ...TESTNET, electionWindows: null, mode: 'dry-run' })).toThrow(/--election-windows <join>,<vote> is required on testnet/);
  });
  it('answers the rendering for testnet', () => {
    expect(registrationPolicy({ ...TESTNET, mode: 'plan' })).toEqual({ interim: 'notYetUsable', electionWindows: { joinWindow: 3600, voteWindow: 3600 }, electionDelay: 3600, keyId: null });
    expect(() => registrationPolicy({ ...TESTNET, electionWindows: '1h,1h', mode: 'plan' })).toThrow(/--election-windows takes <joinSeconds>,<voteSeconds>/);
  });
  it('keeps the files\' values on a devnet unless named', () => {
    expect(registrationPolicy({ network: 'devnet', mode: 'live' })).toEqual({ interim: null, electionWindows: null, electionDelay: null, keyId: null });
    expect(registrationPolicy({ network: 'devnet', mode: 'plan', interim: 'notYetUsable', electionWindows: '0,0' })).toEqual({ interim: 'notYetUsable', electionWindows: { joinWindow: 0, voteWindow: 0 }, electionDelay: null, keyId: null });
  });
  it('refuses an unknown or file-only interim', () => {
    expect(() => registrationPolicy({ ...TESTNET, interim: 'nobody', mode: 'plan' })).toThrow(/--interim must be one of/);
    expect(() => registrationPolicy({ ...TESTNET, interim: 'appointedModerators', mode: 'plan' })).toThrow(/needs identities/);
  });
  it('refuses testnet windows on mainnet', () => {
    expect(() => registrationPolicy({ ...TESTNET, network: 'mainnet', mode: 'plan' })).toThrow(/joinWindow 3600 s is outside 86400/);
    expect(registrationPolicy({ ...TESTNET, network: 'mainnet', electionWindows: '604800,259200', mode: 'plan' }).electionWindows).toEqual({ joinWindow: 604800, voteWindow: 259200 });
  });
  it('signs off devnet only from an explicit key file and key id', () => {
    for (const mode of ['signed-dry-run', 'live']) {
      expect(() => registrationPolicy({ ...TESTNET, mode, production: true })).toThrow(/--maker-key-file <path> --maker-key-id <id>/);
    }
    expect(() => registrationPolicy({ ...TESTNET, mode: 'signed-dry-run', keyFile: '/k.json' })).toThrow(/go together/);
    expect(() => registrationPolicy({ ...TESTNET, mode: 'signed-dry-run', keyId: '2' })).toThrow(/go together/);
    for (const bad of ['', '0x2', '-1', '2.0', 'two']) {
      expect(() => registrationPolicy({ ...TESTNET, mode: 'signed-dry-run', keyFile: '/k.json', keyId: bad })).toThrow(/takes a key id/);
    }
    expect(registrationPolicy({ ...TESTNET, mode: 'signed-dry-run', keyFile: '/k.json', keyId: '2' }).keyId).toBe(2);
  });
  it('broadcasts off devnet only with --production, and never takes it on a devnet', () => {
    expect(() => registrationPolicy({ ...TESTNET, mode: 'live', keyFile: '/k.json', keyId: '2' })).toThrow(/add --production/);
    expect(registrationPolicy({ ...TESTNET, mode: 'live', keyFile: '/k.json', keyId: '2', production: true }).interim).toBe('notYetUsable');
    expect(() => registrationPolicy({ network: 'devnet', mode: 'live', production: true })).toThrow(/--production is for testnet and mainnet/);
  });
});

describe('key files and ops directories', () => {
  it('accepts a private regular file of this user\'s', () => {
    expect(keyFileProblem(stat(0o100600), 501)).toBeNull();
    expect(keyFileProblem(stat(0o100400), 501)).toBeNull();
  });
  it('refuses a file anyone else may access', () => {
    expect(keyFileProblem(stat(0o100644), 501)).toMatch(/mode 0644/);
    expect(keyFileProblem(stat(0o100640), 501)).toMatch(/group or other/);
    expect(keyFileProblem(stat(0o100604), 501)).toMatch(/group or other/);
    expect(keyFileProblem(stat(0o100620), 501)).toMatch(/group or other/);
  });
  it('refuses a directory or another user\'s file', () => {
    expect(keyFileProblem(stat(0o40700, { file: false }), 501)).toMatch(/not a regular file/);
    expect(keyFileProblem(stat(0o100600, { uid: 0 }), 501)).toMatch(/another user/);
  });
  it('wants a 0700 ops directory', () => {
    expect(directoryProblem(stat(0o40700, { file: false }))).toBeNull();
    expect(directoryProblem(stat(0o40755, { file: false }))).toMatch(/mode 0755/);
    expect(directoryProblem(stat(0o100600))).toMatch(/not a directory/);
  });
});

describe('cost estimate and balance gate', () => {
  // Shapes of sakura's beta.6 set (docs/SAKURA_BETA6_DEPLOY.md): blocks paid 19.11e9, social v16 91.74e9.
  const blocks = { documentSchemas: { a: { indices: [{}] }, b: { indices: [{ unique: true }] }, c: { indices: [{}] } } };
  const social = {
    documentSchemas: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i}`, { indices: Array.from({ length: i < 1 ? 15 : 2 }, () => ({})) }])),
    tokens: { 0: { distributionRules: { perpetualDistribution: null, preProgrammedDistribution: null, oncePerIdentityDistribution: { amount: 100 } } } },
  };

  it('charges the protocol 14 registration fees', () => {
    expect(registrationFee(blocks)).toBe(19_000_000_000n);
    expect(registrationFee(social)).toBe(91_000_000_000n);
    expect(registrationFee({ documentSchemas: { a: { indices: [{ contested: {} }] } }, keywords: ['x'] })).toBe(122_000_000_000n);
  });
  it('estimates at least what sakura paid', () => {
    expect(createCostEstimate({ contract: blocks, signedBytes: 1293 })).toBeGreaterThan(19_110_000_000n);
    expect(createCostEstimate({ contract: social, signedBytes: 16532 })).toBeGreaterThan(91_740_000_000n);
  });
  it('scales the storage allowance with a fee multiplier above 1000', () => {
    const at1x = createCostEstimate({ contract: blocks, signedBytes: 1000 });
    expect(createCostEstimate({ contract: blocks, signedBytes: 1000, feeMultiplierPermille: 2000n }) - at1x).toBe(at1x - registrationFee(blocks));
    expect(createCostEstimate({ contract: blocks, signedBytes: 1000, feeMultiplierPermille: 500n })).toBe(at1x);
  });
  it('signs only with the estimate plus 20% in hand', () => {
    expect(balanceGate({ balance: 120n, estimate: 100n })).toEqual({ ok: true, required: 120n });
    expect(balanceGate({ balance: 119n, estimate: 100n }).ok).toBe(false);
    // Testnet's maker today: 101.1e9 against the ~269e9 set.
    expect(balanceGate({ balance: 101_148_941_510n, estimate: 269_000_000_000n }).ok).toBe(false);
  });
  it('prints credits beside cents', () => {
    expect(formatCredits(263_390_000_000n)).toBe('263.39e9 credits (≈15,803¢)');
    expect(formatCredits(1_000_000n)).toBe('0.00e9 credits (≈0.06¢)');
  });
});
