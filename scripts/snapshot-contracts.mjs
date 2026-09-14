#!/usr/bin/env node
/**
 * Snapshot the deployed data contracts of one network into
 * `lib/contracts/bundled/<key>.json`, so the app seeds the SDK from the bundle
 * on load instead of fetching the contracts (see lib/contracts/bundled-contracts.ts).
 *
 *   NETWORK=devnet node scripts/snapshot-contracts.mjs
 *   NETWORK=testnet CONTRACT_IDS=<id>,<id> node scripts/snapshot-contracts.mjs
 *
 * Ids come from every `NEXT_PUBLIC_*CONTRACT_ID` in the network's env file
 * (`.env.devnet` for devnet, `.env.testing` for testnet) plus `CONTRACT_IDS`.
 * Entries already in the bundle are kept and refreshed, so one file per network
 * serves every deployment on it. Re-run after registering or updating a
 * contract; the app revalidates the bundle at runtime anyway, so a stale
 * snapshot costs one extra fetch, not correctness.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlatformVersion } from '@dashevo/evo-sdk';
import { connectSdk, devnetName, network } from './sdk-env.mjs';
import { readEnvFile, REPO_ROOT } from './derive-identities.mjs';

const net = network();
const key = net === 'devnet' ? `devnet-${devnetName()}` : net;
const envFile = net === 'devnet' ? '.env.devnet' : net === 'testnet' ? '.env.testing' : null;

const ids = new Set();
if (envFile) {
  for (const [name, value] of Object.entries(readEnvFile(join(REPO_ROOT, envFile)))) {
    if (/CONTRACT_ID$/.test(name) && value) ids.add(value);
  }
}
for (const id of (process.env.CONTRACT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  ids.add(id);
}
if (ids.size === 0) {
  console.error('No contract ids: set CONTRACT_IDS or NEXT_PUBLIC_*CONTRACT_ID in the env file.');
  process.exit(1);
}

const sdk = await connectSdk();
// rs-sdk seeds devnet connections at protocol version 12 until evo-sdk ships
// the 14 floor; the first proved read of a v6 contract fails there instead of
// ratcheting. One proved read of DPNS (on every chain) ratchets the connection.
await sdk.contracts.fetch('GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec');
const fetched = await sdk.contracts.getMany([...ids]);

const outDir = join(REPO_ROOT, 'lib', 'contracts', 'bundled');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${key}.json`);
const bundle = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, 'utf8'))
  : { network: key, generatedAt: '', contracts: {} };

const platformVersion = PlatformVersion.latest();
let refreshed = 0;
for (const id of [...ids].sort()) {
  const contract = fetched.get(id);
  if (!contract) {
    console.warn(`  missing on ${key}: ${id}`);
    continue;
  }
  bundle.contracts[id] = { version: contract.version, bytes: contract.toBase64(platformVersion) };
  refreshed += 1;
}
bundle.contracts = Object.fromEntries(Object.entries(bundle.contracts).sort(([a], [b]) => a.localeCompare(b)));
bundle.generatedAt = new Date().toISOString();
writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`${refreshed}/${ids.size} contracts written to ${outPath} (${Object.keys(bundle.contracts).length} in bundle)`);
process.exit(0);
