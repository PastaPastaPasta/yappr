/**
 * One-time, manual registration of the optional feature contracts on a devnet.
 *
 * `.env.devnet` blanks the contract ids that have no devnet copy (DM, storefront,
 * key backup, key exchange, vault, auth vault, blog, pollr) so those features
 * fail closed. This script lights them up: it clones each contract's canonical
 * on-chain schemas from testnet and republishes them on the target network under
 * the given owner, exactly like register-test-contracts.mjs does for the social
 * and profile contracts (see that script for why the clone goes through
 * `DataContract.fromJSON` on the fetched contract rather than the checked-in
 * JSON files).
 *
 * Run:
 *   NETWORK=devnet node scripts/register-feature-contracts.mjs \
 *     [--owner <identityId>] [--owner-index <n>] [--only dm,blog,…]
 *
 * The owner defaults to DEVNET_MAKER_IDENTITY_ID in .env.devnet at seed index 9.
 * Prints the `.env.devnet` lines to paste when it finishes.
 */
import { join } from 'node:path';
import { DataContract, PlatformVersion } from '@dashevo/evo-sdk';
import { connectSdk, network } from './sdk-env.mjs';
import { readEnvFile, REPO_ROOT } from './derive-identities.mjs';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';

const DEFAULT_OWNER_IDENTITY_INDEX = 9;
const SDK_TIMEOUT_MS = 30000;

/** Testnet ids match the fallbacks in lib/constants.ts. */
const CONTRACTS = [
  { key: 'dm', envKey: 'NEXT_PUBLIC_YAPPR_DM_CONTRACT_ID', source: 'J7MP9YU1aEGNAe7bjB45XdrjDLBsevFLPK1t1YwFS4ck' },
  { key: 'storefront', envKey: 'NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID', source: '2AUBj86MGTsXP7A3ekD62YoTeDwtJe5b9MxwkWwdg6Ba' },
  { key: 'keyBackup', envKey: 'NEXT_PUBLIC_ENCRYPTED_KEY_BACKUP_CONTRACT_ID', source: '8fmYhuM2ypyQ9GGt4KpxMc9qe5mLf55i8K3SZbHvS9Ts' },
  { key: 'keyExchange', envKey: 'NEXT_PUBLIC_KEY_EXCHANGE_CONTRACT_ID', source: '7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P' },
  { key: 'vault', envKey: 'NEXT_PUBLIC_YAPPR_VAULT_CONTRACT_ID', source: '7RQoHtVZaRZDSrR22s8KcbCJmwSwetJHBcFjx6FJdkJD' },
  { key: 'authVault', envKey: 'NEXT_PUBLIC_YAPPR_AUTH_VAULT_CONTRACT_ID', source: '64RTgHjGXhtiN9t5S4u6hVDps7oHuTBaaHrQEFYcxt9M' },
  { key: 'blog', envKey: 'NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID', source: '9jfarXPwRoKXK4v2JBDaiFg3j78diQuLnHMyVqBZfZNc' },
  { key: 'pollr', envKey: 'NEXT_PUBLIC_POLLR_CONTRACT_ID', source: 'GBCR8JqtXNMZa4B16ZAYm3RkNHrPcU3D36jcAoYWvr8E' },
];

/** Chain metadata that belongs to the source contract, never to a fresh copy. */
const CHAIN_METADATA_KEYS = [
  'createdAt', 'updatedAt',
  'createdAtBlockHeight', 'updatedAtBlockHeight',
  'createdAtEpoch', 'updatedAtEpoch',
];

function parseArgs(argv) {
  const args = { owner: null, ownerIndex: DEFAULT_OWNER_IDENTITY_INDEX, only: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--owner': args.owner = argv[++i]; break;
      case '--owner-index': args.ownerIndex = Number(argv[++i]); break;
      case '--only': args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!Number.isInteger(args.ownerIndex) || args.ownerIndex < 0) {
    throw new Error('--owner-index takes a non-negative integer');
  }
  const known = new Set(CONTRACTS.map((c) => c.key));
  for (const key of args.only ?? []) {
    if (!known.has(key)) throw new Error(`--only: unknown contract "${key}" (known: ${[...known].join(', ')})`);
  }
  return args;
}

/** Re-owns a fetched contract's full JSON so it can be published as a new one. */
function reownedContractJson(source, ownerId, identityNonce, platformVersion) {
  const json = source.toJSON(platformVersion);
  if (!json.documentSchemas || Object.keys(json.documentSchemas).length === 0) {
    throw new Error('Fetched contract exposes no document schemas');
  }
  json.ownerId = ownerId;
  json.id = DataContract.generateId(ownerId, identityNonce).toBase58();
  json.version = 1;
  for (const key of CHAIN_METADATA_KEYS) delete json[key];
  // Registration rejects legacy v0 config blocks ("config version 0 is not
  // supported, minimum version is 1"). Migrate like dpp does: bump to v1 with
  // sizedIntegerTypes=false, keeping the integer semantics the source schemas
  // were authored (and validated) under.
  if (json.config?.$formatVersion === '0') {
    json.config = { ...json.config, $formatVersion: '1', sizedIntegerTypes: false };
  }
  return json;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: NETWORK=devnet node scripts/register-feature-contracts.mjs [--owner <identityId>] [--owner-index <n>] [--only dm,blog,…]');
  process.exit(1);
}

const ownerId = args.owner
  ?? readEnvFile(join(REPO_ROOT, '.env.devnet')).DEVNET_MAKER_IDENTITY_ID;
if (!ownerId) {
  console.error('No owner identity: pass --owner <identityId> or set DEVNET_MAKER_IDENTITY_ID in .env.devnet');
  process.exit(1);
}

const published = {};
try {
  const sdk = await connectSdk({ timeoutMs: SDK_TIMEOUT_MS });
  const sourceSdk = network() === 'testnet' ? sdk : await connectSdk({ timeoutMs: SDK_TIMEOUT_MS, net: 'testnet' });
  console.log(`owner=${ownerId} (seed index ${args.ownerIndex})`);

  const owner = resolveOwner({ botIndex: args.ownerIndex, ownerId });
  const { identityKey, signer } = await signerFor(sdk, owner);

  let identityNonce = ((await sdk.identities.nonce(ownerId)) ?? 0n) + 1n;
  const platformVersion = PlatformVersion.current();

  for (const contract of CONTRACTS) {
    if (args.only && !args.only.includes(contract.key)) continue;
    console.log(`fetching source ${contract.key} contract ${contract.source} from testnet …`);
    const source = await sourceSdk.contracts.fetch(contract.source);
    if (!source) throw new Error(`${contract.key} contract ${contract.source} not found on testnet`);

    const json = reownedContractJson(source, ownerId, identityNonce, platformVersion);
    const dataContract = DataContract.fromJSON(json, false, platformVersion);
    console.log(`publishing ${contract.key} contract (${Object.keys(json.documentSchemas).length} document types) …`);
    const result = await sdk.contracts.publish({ dataContract, identityKey, signer });
    published[contract.envKey] = result.id.toBase58();
    console.log(`${contract.key} contract published: ${published[contract.envKey]}`);
    identityNonce += 1n;
  }
} catch (e) {
  console.error('ERROR:', describeErr(e));
  if (Object.keys(published).length > 0) {
    console.error('Published before the failure (record these before re-running):');
    for (const [key, value] of Object.entries(published)) console.error(`${key}=${value}`);
  }
  process.exit(1);
}

console.log('');
console.log(`Paste into ${network() === 'devnet' ? '.env.devnet' : '.env.testing'}:`);
for (const [key, value] of Object.entries(published)) console.log(`${key}=${value}`);
process.exit(0);
