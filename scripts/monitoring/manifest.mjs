#!/usr/bin/env node
// Record the exact source checkouts used by deploy.yml, without network reads.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SITES, readNetwork, schemaHash } from './config.mjs';

export async function expectations(root, name) {
  const config = readNetwork(root, name);
  if (config.skip) return config;
  const { DataContract, PlatformVersion, ensureInitialized } = await import('@dashevo/evo-sdk');
  await ensureInitialized();
  const pv = PlatformVersion.latest();
  const suffix = config.network === 'devnet' ? `devnet-${config.env.NEXT_PUBLIC_DEVNET_NAME}` : 'testnet';
  const path = name === 'staging'
    ? join(root, 'lib/contracts/snapshots/testnet-staging.json')
    : join(root, 'lib/contracts/bundled', `${suffix}.json`);
  const snapshots = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).contracts : {};
  config.pins = config.pins.map(pin => {
    const snapshot = snapshots[pin.id];
    if (!snapshot) return { ...pin, error: 'No committed contract snapshot; refresh contracts:snapshot before release' };
    const contract = DataContract.fromBase64(snapshot.bytes, false, pv);
    try {
      if (pin.version !== undefined && contract.version !== pin.version) return { ...pin, error: `Snapshot version ${contract.version} differs from pin ${pin.version}` };
      return { ...pin, version: contract.version, schemaHash: schemaHash(contract.toJSON(pv)) };
    } finally { contract.free(); }
  });
  return config;
}

async function main() {
  const [masterRoot, stagingRoot, output, exportRoot = 'site'] = process.argv.slice(2);
  if (!output) throw new Error('Usage: manifest.mjs <master checkout> <staging checkout> <output.json> [combined site export]');
  const sources = { master: resolve(masterRoot), staging: resolve(stagingRoot) };
  const sites = [];
  const networks = {};
  for (const name of ['production', 'testing', 'staging', 'devnet']) networks[name] = await expectations(sources[['staging', 'devnet'].includes(name) ? 'staging' : 'master'], name);
  for (const site of SITES) {
    const root = sources[site.source];
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const buildId = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const basePath = new URL(site.url).pathname;
    const chunksRoot = join(exportRoot, basePath, '_next/static/chunks');
    const bundlePaths = existsSync(chunksRoot) ? readdirSync(chunksRoot, { recursive: true }).filter(path => path.endsWith('.js')).map(path => `${basePath}_next/static/chunks/${path}`) : [];
    sites.push({ ...site, commit, buildId, bundlePaths, config: readNetwork(root, site.network) });
  }
  writeFileSync(output, `${JSON.stringify({ version: 1, sites, networks }, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
