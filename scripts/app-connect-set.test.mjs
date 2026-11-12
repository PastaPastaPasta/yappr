import appConnectEntries from './app-connect-entries.cjs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { APP_CONNECT_ENTRIES, appConnectEnvLines, entriesToCreate, fileSha256, planAppConnectSet } from './app-connect-set.mjs';
import { testnetAppendProblem } from './app-connect-journal.mjs';

const MAKER = '11111111111111111111111111111112';
const PINS = [
  ['app', 'yappr-app-contract.json', 'd3acd888168f6ee074d2eb7f73442917b255aa0be3b6417698d637844ce41f41'],
  ['social', 'yappr-social-contract-v19.json', 'bae9bd60f16b917f39309a8ca2dcc495687ec35174fa9caa08a8b0311e318971'],
  ['blocks', 'yappr-blocks-contract.json', 'ba0ef67a458cae5c702612a096a6b71fb0098fa370b3861da6da735dd80d3677'],
  ['dmV5', 'yappr-dm-contract-v5.json', '4fe2b3f46447d8aff30efcafc0e6235bee97724e34e7c96130951a59b0037c21'],
  ['blog', 'yappr-blog-contract-v11.json', 'd1a53c31803a2f6f057700b358755b4d927318bfdcd5d2cb5b6718e8942dca6c'],
  ['pollr', 'pollr-contract.json', 'a77afe5f27ad97d80e530551bbd5561ab02b1c622698b1a583a4893b03bd2347'],
  ['storefront', 'yappr-storefront-contract-v12.json', '873dc5c665c78cbd8390de181d4bb373068d042a405c002620e123b24df0f214'],
  ['passkeyVault', 'yappr-passkey-vault-contract.json', '14094cadcaf6c9b575fcb97ea53b769c5b0d88cfa99b3c5c827da0ab176f73c5'],
];
const FLAGS = ['--maker', MAKER, '--start-nonce', '1', '--interim', 'notYetUsable', '--election-windows', '604800,604800', '--election-delay', '604800', '--challenge-cool-down', '2592000'];
const run = (network, extra = []) => spawnSync(process.execPath, ['scripts/register-app-connect-contracts.mjs', '--plan', ...FLAGS, ...extra], {
  encoding: 'utf8', env: { ...process.env, NETWORK: network }, timeout: 30_000,
});

describe('the default release set', () => {
  it('pins exactly the eight v19 release files, matching their bytes', () => {
    expect(APP_CONNECT_ENTRIES.map(({ name, file, sha256 }) => [name, file, sha256])).toEqual(PINS);
    for (const entry of APP_CONNECT_ENTRIES) expect(fileSha256(entry.file)).toBe(entry.sha256);
  });

  it('emits the v19 social, blog and storefront ids and exactly eight pinned members', () => {
    const plan = planAppConnectSet({ makerId: MAKER, startNonce: 1n, generateId: (owner, nonce) => `${owner}-${nonce}` });
    const env = appConnectEnvLines(plan);
    expect(env).toContain(`NEXT_PUBLIC_YAPPR_CONTRACT_ID=${MAKER}-2`);
    expect(env).toContain(`NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID=${MAKER}-5`);
    expect(env).toContain(`NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID=${MAKER}-7`);
    expect(env.find((line) => line.startsWith('NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS=')).split('=')[1].split(',')).toHaveLength(8);
    expect(new Set(plan.contracts.map((c) => c.envKey)).size).toBe(8);
    expect(() => entriesToCreate(plan.contracts, 'passkeyVault')).toThrow(/nothing to append/);
    for (const name of ['socialV18', 'blogV10', 'storefrontV11']) expect(() => entriesToCreate(plan.contracts, name)).toThrow(/not an entry/);
  });

  it.each(['mainnet', 'testnet'])('builds and audits exactly eight unsigned creates on %s', (network) => {
    const result = run(network);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const rows = [...result.stdout.matchAll(/^\s+\d+\s+(\w+)\s+\S+\s+(yappr-\S+|pollr-\S+)/gm)];
    expect(rows.map((row) => [row[1], row[2]])).toEqual(PINS.map(([name, file]) => [name, file]));
    expect(result.stdout.match(/decoded by the wasm-sdk and wasm-dpp2/g)).toHaveLength(8);
    expect(result.stdout).toContain('estimated cost of app, social, blocks, dmV5, blog, pollr, storefront, passkeyVault:');
    expect(result.stdout).not.toMatch(/socialV18|blogV10|storefrontV11/);
    for (const key of ['NEXT_PUBLIC_YAPPR_CONTRACT_ID', 'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID', 'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID']) expect(result.stdout).toMatch(new RegExp(`^${key}=\\S+$`, 'm'));
  }, 30_000);

  it('rejects the rehearsal selector on mainnet before preparing creates', () => {
    const result = run('mainnet', ['--testnet-set', 'rehearsal']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--testnet-set is for testnet');
    expect(result.stdout).toBe('');
  });

  it('allows a fresh v19 maker to register and later append to its own group', () => {
    expect(testnetAppendProblem('testnet', null, { maker: MAKER })).toBeNull();
    expect(testnetAppendProblem('testnet', 'social', { maker: MAKER })).toBeNull();
    expect(testnetAppendProblem('mainnet', null, { testnetSet: 'rehearsal', maker: MAKER })).toMatch(/for testnet/);
    for (const appendAfter of [null, 'passkeyVault']) {
      expect(testnetAppendProblem('testnet', appendAfter, { maker: appConnectEntries.REGISTERED_TESTNET_MAKER })).toMatch(/requires a new maker/);
    }
  });
});
