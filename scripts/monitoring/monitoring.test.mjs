import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contractPins, incidentPlan, readNetwork, schemaHash, thresholds } from './config.mjs';
import { activityFilters, checkFresh, countActivity } from './chain.mjs';
import { lazyChunks, smokeSite } from './sites.mjs';

const id = '9hZwi4W3qqNtHFygjkgDvgud4EmE3dUxQUk5NjTYsdqN';
afterEach(() => vi.unstubAllGlobals());

describe('release configuration', () => {
  it('uses App Connect versions over defaults and includes the anchor', () => {
    const pins = contractPins({ NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID: id, NEXT_PUBLIC_APP_CONNECT_APP_ID: id, NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: `${id}:2` });
    expect([...pins]).toEqual([[id, 2]]);
    expect(() => contractPins({ NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS: `${id}:0` })).toThrow();
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
  expect(activityFilters(reportSchema)).toEqual([[[ 'status', '==', 1 ]], [[ 'status', '==', 2 ]], [[ 'status', '==', 3 ]]]);
  const document = n => ({ id: { toBase58: () => String(n) }, free: vi.fn() });
  const page = new Map(Array.from({ length: 100 }, (_, i) => [String(i), document(i)]));
  const query = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce(new Map([['100', document(100)]]));
  await expect(countActivity({ documents: { query } }, id, 'post', { indices: [{ properties: [{ $createdAt: 'asc' }] }] }, 1000, 100)).rejects.toThrow('at least 101');
  expect(query.mock.calls[1][0]).toMatchObject({ startAfter: '99', where: [['$createdAt', '>=', 1000]] });
});

it('validates loaded subpath bundles and buildId against trusted expectations', async () => {
  const html = '<script src="/testing/_next/static/chunks/app.js"></script><script>self.__next_f.push([1,"{\\"buildId\\":\\"abc1234\\"}"])</script>';
  const fetchMock = vi.fn(async url => new Response(String(url).endsWith('app.js') ? `contract="${id}"` : html));
  vi.stubGlobal('fetch', fetchMock);
  const site = { url: 'https://yap.pr/testing/', buildId: 'abc1234', commit: 'abc1234', config: { pins: [{ id }] } };
  await expect(smokeSite(site)).resolves.toContain('1 contract ids');
  await expect(smokeSite({ ...site, buildId: 'wrong' })).rejects.toThrow('expected wrong');
  await expect(smokeSite({ ...site, config: { pins: [{ id: 'missing-contract' }] } })).rejects.toThrow('missing configured contract');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
  await expect(smokeSite(site)).rejects.toThrow('HTTP 503');
});

it('discovers independently hashed mirror lazy chunks without executing JavaScript', async () => {
  const source = 'w.u=function(e){return 42===e?"static/chunks/42-abc.js":"static/chunks/"+e+"."+({1795:"48762af95e1437d0"})[e]+".js"},w.miniCssF=function(e){}';
  expect(lazyChunks(source)).toEqual(['static/chunks/42-abc.js', 'static/chunks/1795.48762af95e1437d0.js']);
  const html = '<script src="/_next/static/chunks/webpack-own.js"></script><script>"buildId":"abc1234"</script>';
  vi.stubGlobal('fetch', vi.fn(async url => new Response(String(url).endsWith('webpack-own.js') ? source : String(url).endsWith('.js') ? id : html)));
  await expect(smokeSite({ name: 'mirror', url: 'https://yappr.pages.dev/', buildId: 'abc1234', config: { pins: [{ id }] }, bundlePaths: ['/_next/static/chunks/other-provider-404.js'] })).resolves.toContain('1 contract ids');
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
    expect(failed?.stdout).toContain('SKIP chain/production: .env.testnet does not exist');
  } finally { rmSync(root, { recursive: true }); }
}, 30000);
