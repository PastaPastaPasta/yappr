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
 *
 *   NETWORK=testnet node scripts/snapshot-contracts.mjs --qa <staging-old|beta>
 *
 * writes a QA build's own snapshot instead (QA_BUILDS in release-config.cjs):
 * exactly the contracts its env file names, always pruned, which is what
 * `assertSnapshotPins` requires of it at build time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlatformVersion } from '@dashevo/evo-sdk';
import { connectSdk, devnetName, network } from './sdk-env.mjs';
import { readEnvFile, REPO_ROOT } from './derive-identities.mjs';
import { DASHPAY_CONTRACT_ID, SEEDED_TOPOLOGIES } from './seed/seed-lib.mjs';
import { snapshotContractIds, snapshotEnvFiles } from './snapshot-contract-config.mjs';
import releaseConfig from './release-config.cjs';

const qaAt = process.argv.indexOf('--qa');
const qa = qaAt === -1 ? null : releaseConfig.QA_BUILDS[process.argv[qaAt + 1]];
if (qaAt !== -1 && (!qa || network() !== 'testnet')) {
  console.error(`--qa takes ${Object.keys(releaseConfig.QA_BUILDS).join(' or ')}, on NETWORK=testnet`);
  process.exit(1);
}
const prune = qa !== null || process.argv.includes('--prune');
const net = network();
const key = net === 'devnet' ? `devnet-${devnetName()}` : net;
const ids = snapshotContractIds(
  qa ? [readEnvFile(join(REPO_ROOT, qa.envFile))] : snapshotEnvFiles(net).map(file => readEnvFile(join(REPO_ROOT, file))),
  qa ? '' : process.env.CONTRACT_IDS ?? '', DASHPAY_CONTRACT_ID, SEEDED_TOPOLOGIES,
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

const outDir = join(REPO_ROOT, 'lib', 'contracts', 'bundled');
if (!qa) mkdirSync(outDir, { recursive: true });
const outPath = qa ? join(REPO_ROOT, qa.snapshot) : join(outDir, `${key}.json`);
const bundle = existsSync(outPath) && !prune
  ? JSON.parse(readFileSync(outPath, 'utf8'))
  : { network: key, generatedAt: '', contracts: {} };

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
