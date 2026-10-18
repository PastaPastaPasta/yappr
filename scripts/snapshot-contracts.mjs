#!/usr/bin/env node
/**
 * Snapshot the deployed data contracts of one network into
 * `lib/contracts/bundled/<key>.json`, so the app seeds the SDK from the bundle
 * on load instead of fetching the contracts (see lib/contracts/bundled-contracts.ts).
 *
 *   NETWORK=devnet node scripts/snapshot-contracts.mjs [--prune]
 *   NETWORK=testnet CONTRACT_IDS=<id>,<id> node scripts/snapshot-contracts.mjs
 *
 * Ids come from every `NEXT_PUBLIC_*CONTRACT_ID` in the network's env file
 * (`.env.devnet` for devnet, BOTH `.env.testing` and `.env.testnet` for testnet,
 * when present) plus `CONTRACT_IDS` and the App Connect anchor,
 * plus the DashPay system contract when the env file sets a topology that reads it (v10 onwards)
 * (their base profile, which the app preloads).
 * Entries already in the bundle are kept and refreshed, so one file per network
 * serves every deployment on it; `--prune` drops every entry this run did not
 * request, for a chain that was wiped and re-cut. Re-run after registering or
 * updating a contract; the app revalidates the bundle at runtime anyway, so a
 * stale snapshot costs one extra fetch, not correctness.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlatformVersion } from '@dashevo/evo-sdk';
import { connectSdk, devnetName, network } from './sdk-env.mjs';
import { readEnvFile, REPO_ROOT } from './derive-identities.mjs';
import { DASHPAY_CONTRACT_ID, SEEDED_TOPOLOGIES } from './seed/seed-lib.mjs';
import { snapshotContractIds, snapshotEnvFiles } from './snapshot-contract-config.mjs';

const prune = process.argv.includes('--prune');
const staging = process.argv.includes('--staging');
const net = network();
const key = net === 'devnet' ? `devnet-${devnetName()}` : net;
const ids = snapshotContractIds(
  snapshotEnvFiles(net, staging).map(file => readEnvFile(join(REPO_ROOT, file))),
  process.env.CONTRACT_IDS ?? '', DASHPAY_CONTRACT_ID, SEEDED_TOPOLOGIES,
);
if (ids.length === 0) {
  console.error('No contract ids: set CONTRACT_IDS or NEXT_PUBLIC_*CONTRACT_ID in the env file.');
  process.exit(1);
}

const sdk = await connectSdk();
// rs-sdk seeds devnet connections at protocol version 12 until evo-sdk ships
// the 14 floor; the first proved read of a v6 contract fails there instead of
// ratcheting. One proved read of DPNS (on every chain) ratchets the connection.
await sdk.contracts.fetch('GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec');
const fetched = await sdk.contracts.getMany(ids);
// Do not write a partial (or partially pruned) artifact on a missing contract.
const missing = ids.filter(id => !fetched.get(id));
if (missing.length) throw new Error(`Missing contracts on ${key}; snapshot unchanged: ${missing.join(', ')}`);

const outDir = join(REPO_ROOT, 'lib', 'contracts', staging ? 'snapshots' : 'bundled');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${staging ? 'testnet-staging' : key}.json`);
const bundle = existsSync(outPath) && !prune && !staging
  ? JSON.parse(readFileSync(outPath, 'utf8'))
  : { network: staging ? 'testnet' : key, generatedAt: '', contracts: {} };

const platformVersion = PlatformVersion.latest();
let refreshed = 0;
for (const id of ids) {
  const contract = fetched.get(id);
  bundle.contracts[id] = { version: contract.version, bytes: contract.toBase64(platformVersion) };
  refreshed += 1;
}
bundle.contracts = Object.fromEntries(Object.entries(bundle.contracts).sort(([a], [b]) => a.localeCompare(b)));
bundle.generatedAt = new Date().toISOString();
writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`${refreshed}/${ids.length} contracts written to ${outPath} (${Object.keys(bundle.contracts).length} in bundle)`);
process.exit(0);
