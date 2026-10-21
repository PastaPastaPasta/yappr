import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contractPins, contractRoles, readNetwork, schemaHash, siteNetwork, siteTopologies, thresholds } from './config.mjs';
import { incidentPlan } from './incident-plan.mjs';
import { activityFilters, checkFresh, checkAppConnectGroup, countActivity } from './chain.mjs';
import { lazyChunks, smokeSite } from './sites.mjs';

const metadata = roles => `<meta name="yappr-contract-config" content="${JSON.stringify({ $network: { network: 'testnet' }, $topologies: siteTopologies(), ...roles }).replaceAll('"', '&quot;')}"/>`;
const id = '9hZwi4W3qqNtHFygjkgDvgud4EmE3dUxQUk5NjTYsdqN';
const groupEnv = { NEXT_PUBLIC_APP_CONNECT_APP_ID: id, NEXT_PUBLIC_APP_CONNECT_GROUP_ID: id, NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER: id };
afterEach(() => vi.unstubAllGlobals());

describe('release configuration', () => {
  it('uses App Connect versions over defaults and includes the anchor', () => {
    const pins = contractPins({ ...groupEnv, NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: id, NEXT_PUBLIC_APP_CONNECT_APP_ID: id, NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: `${id}:2` });
    expect([...pins]).toEqual([[id, 2]]);
    expect(() => contractPins({ ...groupEnv, NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: `${id}:0` })).toThrow();
  });
  it('skips unregistered sets without consulting other env files or process env', () => {
    const root = mkdtempSync(join(tmpdir(), 'yappr-monitor-'));
    try {
      writeFileSync(join(root, '.env.testing'), `NEXT_PUBLIC_YAPPR_CONTRACT_ID=${id}\n`);
      expect(readNetwork(root, 'production').skip).toContain('does not exist');
      writeFileSync(join(root, '.env.testnet'), 'NEXT_PUBLIC_YAPPR_CONTRACT_ID=\n');
      expect(readNetwork(root, 'production').skip).toContain('no contract ids');
      expect(readNetwork(root, 'testing').pins).toEqual([{ id }]);
    } finally { rmSync(root, { recursive: true }); }
  });
  it.each(['production', 'staging'])('pins the %s release set to its committed snapshot', async name => {
    const { expectations } = await import('./manifest.mjs');
    const config = await expectations(process.cwd(), name);
    expect(config.network).toBe('testnet');
    // Eight group members plus the DashPay profile, DPNS and token-history system contracts.
    expect(config.pins).toHaveLength(11);
    const snapshot = JSON.parse(readFileSync(new URL('../../lib/contracts/bundled/testnet.json', import.meta.url), 'utf8'));
    expect(config.pins.every(pin => snapshot.contracts[pin.id] && !pin.error && pin.schemaHash)).toBe(true);
    expect(config.env.NEXT_PUBLIC_APP_CONNECT_APP_ID).toBe('D8benQGnycUTXbT8GRAaYf3GZMKVcWESiF9NyyW1Bi4e');
  });
  it('hashes schema values independently of object key order', () => {
    expect(schemaHash({ b: { z: 1, a: 2 }, a: [1, 2] })).toBe(schemaHash({ a: [1, 2], b: { a: 2, z: 1 } }));
    expect(schemaHash({ required: ['a', 'b'] })).not.toBe(schemaHash({ required: ['b', 'a'] }));
  });
  it('validates configurable thresholds and minimum node coverage', () => {
    expect(thresholds({}).MAKER_MIN_CREDITS).toBe(200e9);
    expect(thresholds({ MONITOR_THRESHOLDS: '{"MAKER_MIN_CREDITS":42}' }).MAKER_MIN_CREDITS).toBe(42);
    expect(() => thresholds({ MONITOR_NODE_MIN: '1' })).toThrow();
    expect(() => thresholds({ MONITOR_POST_MAX: '-1' })).toThrow();
  });
});

it('updates incidents by stable title, closes duplicates on recovery, and never closes skips', () => {
  const existing = [{ number: 1, title: '[monitoring] site/production' }, { number: 2, title: '[monitoring] site/production' }];
  expect(incidentPlan([{ key: 'site/production', status: 'fail' }], existing)[0]).toMatchObject({ action: 'update', issues: existing });
  expect(incidentPlan([{ key: 'site/production', status: 'pass' }], existing)[0].action).toBe('close');
  expect(incidentPlan([{ key: 'site/production', status: 'skip' }], existing)).toEqual([]);
  expect(incidentPlan([{ key: 'chain/devnet', status: 'fail' }], existing)[0].action).toBe('open');
});

it('rejects stale proofs and old protocol data', () => {
  const limits = thresholds({});
  expect(() => checkFresh({ timeMs: 999000, protocolVersion: 14 }, limits, 1000000)).not.toThrow();
  expect(() => checkFresh({ timeMs: 1, protocolVersion: 14 }, limits, 1000000)).toThrow('stale');
  expect(() => checkFresh({ timeMs: 999000, protocolVersion: 13 }, limits, 1000000)).toThrow('protocol');
});

const reportSchema = { indices: [{ properties: [{ status: 'asc' }, { $createdAt: 'asc' }] }], properties: { status: { type: 'integer', minimum: 1, maximum: 3 } } };
it('covers every report status and follows activity pages until the threshold is exceeded', async () => {
  expect(activityFilters({ ...reportSchema, indices: [{ properties: [{ $ownerId: 'asc' }, { $createdAt: 'asc' }] }, ...reportSchema.indices] })).toEqual(activityFilters(reportSchema));
  expect(activityFilters(reportSchema)).toEqual([[[ 'status', '==', null ]], [[ 'status', '==', 1 ]], [[ 'status', '==', 2 ]], [[ 'status', '==', 3 ]]]);
  const document = n => ({ id: { toBase58: () => String(n) }, free: vi.fn() });
  const page = new Map(Array.from({ length: 100 }, (_, i) => [String(i), document(i)]));
  const query = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(new Map([['100', document(100)]]));
  await expect(countActivity({ documents: { query } }, id, 'post', { indices: [{ properties: [{ $createdAt: 'asc' }] }] }, 1000, 100)).rejects.toThrow('at least 101');
  expect(query.mock.calls[1][0]).toMatchObject({ startAfter: '99', where: [['$createdAt', '>=', 1000]] });
});

it('validates loaded subpath bundles and buildId against trusted expectations', async () => {
  const html = metadata({ NEXT_PUBLIC_YAPPR_CONTRACT_ID: id }) + '<script src="/testing/_next/static/chunks/app.js"></script><script>self.__next_f.push([1,"{\\"buildId\\":\\"abc1234\\"}"])</script>';
  const fetchMock = vi.fn(async url => new Response(String(url).endsWith('app.js') ? `contract="${id}"` : html));
  vi.stubGlobal('fetch', fetchMock);
  const site = { url: 'https://yap.pr/testing/', buildId: 'abc1234', commit: 'abc1234', config: { env: { NEXT_PUBLIC_YAPPR_CONTRACT_ID: id }, pins: [{ id }] } };
  await expect(smokeSite(site)).resolves.toContain('1 contract ids');
  await expect(smokeSite({ ...site, buildId: 'wrong' })).rejects.toThrow('expected wrong');
  await expect(smokeSite({ ...site, config: { pins: [{ id: 'missing-contract' }] } })).rejects.toThrow('missing configured contract');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
  await expect(smokeSite(site)).rejects.toThrow('HTTP 503');
});

it('discovers independently hashed mirror lazy chunks without executing JavaScript', async () => {
  const source = 'w.u=function(e){return 42===e?"static/chunks/42-abc.js":"static/chunks/"+e+"."+({1795:"48762af95e1437d0"})[e]+".js"},w.miniCssF=function(e){}';
  expect(lazyChunks(source)).toEqual(['static/chunks/42-abc.js', 'static/chunks/1795.48762af95e1437d0.js']);
  const html = metadata({ NEXT_PUBLIC_YAPPR_CONTRACT_ID: id }) + '<script src="/_next/static/chunks/webpack-own.js"></script><script>"buildId":"abc1234"</script>';
  vi.stubGlobal('fetch', vi.fn(async url => new Response(String(url).endsWith('webpack-own.js') ? source : String(url).endsWith('.js') ? id : html)));
  await expect(smokeSite({ name: 'mirror', url: 'https://yappr.pages.dev/', buildId: 'abc1234', config: { env: { NEXT_PUBLIC_YAPPR_CONTRACT_ID: id }, pins: [{ id }] }, bundlePaths: ['/_next/static/chunks/other-provider-404.js'] })).resolves.toContain('1 contract ids');
});

it('reads the deployed network set instead of the monitoring checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'yappr-deployed-monitor-'));
  try {
    const manifest = join(root, 'deployed.json');
    writeFileSync(manifest, JSON.stringify({ networks: { testing: { name: 'testing', skip: 'deployed testing set is not registered' } } }));
    const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('./chain.mjs', import.meta.url)), 'testing', manifest], { cwd: root, encoding: 'utf8', timeout: 15000 });
    expect(JSON.parse(stdout.trim())).toMatchObject({ status: 'skip', detail: 'deployed testing set is not registered' });
    // Artifact loss still runs diagnostic workers rather than hiding the chain.
    let failed;
    try { execFileSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), '--chain-only', '--network', 'production', '--manifest', join(root, 'absent.json')], { cwd: root, encoding: 'utf8', timeout: 15000 }); }
    catch (error) { failed = error; }
    expect(failed?.stdout).toContain('FAIL monitor/expectations');
    expect(failed?.stdout).toContain('SKIP diagnostic/chain/production: .env.testnet does not exist');
    const recovered = incidentPlan([{ key: 'diagnostic/chain/testing/availability', status: 'pass' }], [{ title: '[monitoring] chain/testing/availability', number: 123 }]);
    expect(recovered[0].issues).toEqual([]);
  } finally { rmSync(root, { recursive: true }); }
}, 30000);

it('rejects a wrong active role even when a snapshot bundle contains the expected id', async () => {
  const html = metadata({ NEXT_PUBLIC_YAPPR_CONTRACT_ID: 'wrong-active-id' }) + '<script src="/_next/static/chunks/snapshot.js"></script><script>"buildId":"abc1234"</script>';
  const fetchMock = vi.fn(async url => new Response(String(url).endsWith('.js') ? id : html));
  vi.stubGlobal('fetch', fetchMock);
  await expect(smokeSite({ url: 'https://yap.pr/', buildId: 'abc1234', config: { env: { NEXT_PUBLIC_YAPPR_CONTRACT_ID: id }, pins: [{ id }] } })).rejects.toThrow('Active NEXT_PUBLIC_YAPPR_CONTRACT_ID: wrong-active-id');
});

it.each(['testing', 'devnet', 'staging'])('exposes every configured role for the %s build, including disabled and auxiliary registrations', async name => {
  const config = readNetwork(process.cwd(), name);
  try {
    vi.resetModules();
    for (const [key, value] of Object.entries(config.env)) vi.stubEnv(key, value);
    const { monitoringContractConfig } = await import('../../lib/monitoring-contract-config');
    expect(monitoringContractConfig.$topologies).toEqual(siteTopologies(config.env));
    expect(monitoringContractConfig.$network).toEqual(siteNetwork(config.env, config.network));
    expect(contractRoles(monitoringContractConfig)).toMatchObject(contractRoles(config.env));
  } finally { vi.unstubAllEnvs(); }
});

it('accepts canonical 32-byte identifiers with shorter Base58 encodings', () => {
  const short = '1'.repeat(31) + '2';
  expect([...contractPins({ ...groupEnv, NEXT_PUBLIC_APP_CONNECT_APP_ID: short, NEXT_PUBLIC_YAPPR_CONTRACT_ID: short, NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: `${short}:2` })]).toEqual([[short, 2]]);
  expect(() => contractPins({ NEXT_PUBLIC_YAPPR_CONTRACT_ID: '1'.repeat(31) })).toThrow('Invalid contract id');
});

it('rejects a wrong browser network with matching roles and bundles', async () => {
  const html = metadata({ NEXT_PUBLIC_YAPPR_CONTRACT_ID: id, $network: { network: 'mainnet' } }) + '<script src="/_next/static/chunks/app.js"></script><script>"buildId":"abc1234"</script>';
  vi.stubGlobal('fetch', vi.fn(async url => new Response(String(url).endsWith('.js') ? id : html)));
  await expect(smokeSite({ url: 'https://yap.pr/', buildId: 'abc1234', config: { network: 'testnet', env: { NEXT_PUBLIC_YAPPR_CONTRACT_ID: id }, pins: [{ id }] } })).rejects.toThrow('Active network settings');
});

it('rejects different valid query topologies with matching IDs and browser network', async () => {
  const html = metadata({ NEXT_PUBLIC_YAPPR_CONTRACT_ID: id }) + '<script src="/_next/static/chunks/app.js"></script><script>"buildId":"abc1234"</script>';
  vi.stubGlobal('fetch', vi.fn(async url => new Response(String(url).endsWith('.js') ? id : html)));
  await expect(smokeSite({ url: 'https://yap.pr/', buildId: 'abc1234', config: { network: 'testnet', env: { NEXT_PUBLIC_YAPPR_CONTRACT_ID: id, NEXT_PUBLIC_CONTRACT_TOPOLOGY: 'v16' }, pins: [{ id }] } })).rejects.toThrow('Active query topologies');
});

it('checks default effective query topologies against their owning browser configuration', async () => {
  try {
    vi.resetModules();
    for (const key of Object.keys(siteTopologies())) vi.stubEnv(key, '');
    const { monitoringContractConfig } = await import('../../lib/monitoring-contract-config');
    expect(monitoringContractConfig.$topologies).toEqual(siteTopologies());
  } finally { vi.unstubAllEnvs(); }
});

it('proves and pages every group member kind; rejects expansions with unchanged contract pins', async () => {
  const metadata = { timeMs: Date.now(), protocolVersion: 14 };
  const env = { ...groupEnv, NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: `${id}:2` };
  const info = { ownerId: id, adminIds: [], free: vi.fn() };
  const membersWithProof = vi.fn(async ({ kind, startAfter }) => ({ metadata, data: { kind, [kind]: kind === 'contracts' ? (startAfter ? [] : [id]) : [], ...(kind === 'contracts' && !startAfter ? { nextStartAfter: { contractId: id } } : {}) } }));
  const sdk = { contractGroups: { infoWithProof: vi.fn(async () => ({ metadata, data: info })), membersWithProof } };
  await expect(checkAppConnectGroup(sdk, env, thresholds({}))).resolves.toContain('1 exact pinned members');
  expect(membersWithProof.mock.calls.map(([query]) => query.kind)).toEqual(['contracts', 'contracts', 'documentTypes', 'tokens']);
  expect(membersWithProof.mock.calls[1][0].startAfter).toEqual({ contractId: id });
  for (const [kind, extra] of [['contracts', 'extra-contract'], ['documentTypes', { contractId: id, documentTypeName: 'post' }], ['tokens', { contractId: id, tokenPosition: 0 }]]) {
    membersWithProof.mockImplementation(async query => ({ metadata, data: { kind: query.kind, [query.kind]: query.kind === 'contracts' ? [id, ...(kind === 'contracts' ? [extra] : [])] : query.kind === kind ? [extra] : [] } }));
    await expect(checkAppConnectGroup(sdk, env, thresholds({}))).rejects.toThrow('unexpected-members');
  }
  info.ownerId = 'other';
  await expect(checkAppConnectGroup(sdk, env, thresholds({}))).rejects.toThrow('owner-mismatch');
  info.ownerId = id; info.adminIds = ['admin'];
  await expect(checkAppConnectGroup(sdk, env, thresholds({}))).rejects.toThrow('admins-mismatch');
  info.adminIds = [];
  membersWithProof.mockImplementation(async ({ kind }) => ({ metadata, data: { kind, [kind]: [] } }));
  await expect(checkAppConnectGroup(sdk, env, thresholds({}))).rejects.toThrow('missing-members');
  expect(info.free).toHaveBeenCalledTimes(7);
});

it('uses the actual v16 report schema to count unresolved and resolved reports', async () => {
  const schema = JSON.parse(readFileSync(new URL('../../contracts/yappr-social-contract-v16.json', import.meta.url), 'utf8')).documentSchemas.report;
  expect(activityFilters(schema)).toEqual([null, 1, 2, 3].map(status => [['status', '==', status]]));
  const document = n => ({ id: { toBase58: () => String(n) }, free: vi.fn() });
  const documents = Array.from({ length: 102 }, (_, n) => ({ status: n === 101 ? 1 : null, document: document(n) }));
  const query = vi.fn(async ({ where, startAfter }) => {
    const status = where[0][2];
    const selected = documents.filter(entry => entry.status === status && (!startAfter || Number(entry.document.id.toBase58()) > Number(startAfter))).slice(0, 100);
    return new Map(selected.map(entry => [entry.document.id.toBase58(), entry.document]));
  });
  await expect(countActivity({ documents: { query } }, id, 'report', schema, 1000, 100)).rejects.toThrow('at least 101');
  await expect(countActivity({ documents: { query } }, id, 'report', schema, 1000, 200)).resolves.toContain('102 retained');
  const index = schema.indices.find(index => index.name === 'byStatus');
  index.skipIfAbsent = true;
  expect(() => activityFilters(schema)).toThrow('No usable bounded time index');
});

it('rejects App Connect pins rejected by browser login before probing any group', async () => {
  const env = { ...groupEnv, NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: `${id},${id}:2` };
  expect(() => contractPins(env)).toThrow('Invalid App Connect pins');
  await expect(checkAppConnectGroup({}, env, thresholds({}))).rejects.toThrow('Invalid App Connect pins');
  env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS = '1'.repeat(31) + '2';
  expect(() => contractPins(env)).toThrow('anchor among members');
  await expect(checkAppConnectGroup({}, env, thresholds({}))).rejects.toThrow('anchor among members');
});

it('counts each report once when moderation moves it between status partitions', async () => {
  const schema = JSON.parse(readFileSync(new URL('../../contracts/yappr-social-contract-v16.json', import.meta.url), 'utf8')).documentSchemas.report;
  const document = n => ({ id: { toBase58: () => String(n) }, free: vi.fn() });
  const query = vi.fn(async ({ where, startAfter }) => {
    const status = where[0][2];
    const ids = status === null && !startAfter ? Array.from({ length: 100 }, (_, n) => n) : status === 1 ? [0] : [];
    return new Map(ids.map(n => [String(n), document(n)]));
  });
  await expect(countActivity({ documents: { query } }, id, 'report', schema, 1000, 100)).resolves.toContain('100 retained');
  expect(query.mock.calls.map(([q]) => q.where[0][2])).toEqual([null, null, 1, 2, 3]);
});
