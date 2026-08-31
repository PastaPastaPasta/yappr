/**
 * One-time, manual registration of the dedicated /testing (or /devnet) data contracts.
 *
 * Publishes a fresh copy of the yappr social contract and of the unified profile
 * contract, owned by the e2e bot identity at derivation index 0 and signed with
 * its AUTHENTICATION/CRITICAL key. Re-running this is also the "reset test state"
 * mechanism: new contracts start empty, and the old ones are simply abandoned.
 *
 * Both schemas are read back from an already-deployed contract and re-published
 * verbatim under the new owner. (Reading from chain rather than a checked-in
 * file matters: the chain's `schemas` getter returns the canonical registrable
 * form, while old exports with per-type `mutable` keys are rejected by current
 * DPP validation.)
 *
 * The clone goes through the contract's full JSON, so the social contract's
 * `tokens` block (plus `groups`, `config`, `keywords`, `description`) is carried
 * over too. `tokenCost` lives inside the document schemas and always followed
 * them; the token configuration did not, so dropping it used to leave the copy
 * with `tokenCost` entries naming a token that did not exist. After publishing,
 * set the direct-purchase price with scripts/set-yapp-price.mjs.
 *
 * Run:
 *   node scripts/register-test-contracts.mjs [--owner <identityId>] [--only social|profile]
 *
 *   # publish onto a devnet from the testnet staging contract's on-chain schemas
 *   NETWORK=devnet node scripts/register-test-contracts.mjs \
 *     --source-network testnet \
 *     --from-social 9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9 \
 *     --owner <devnetMakerId> --owner-index 9
 *
 * The owner defaults to the first entry of E2E_IDENTITY_IDS in .env.testing.
 * Prints the `.env.testing` / `.env.devnet` lines to paste when it finishes.
 */
import { DataContract, IdentitySigner, PlatformVersion } from '@dashevo/evo-sdk';
import { connectSdk, network } from './sdk-env.mjs';
import {
  CRITICAL_AUTH_KEY_ID,
  criticalAuthKey,
  deriveIdentityKeys,
  loadIdentityIds,
} from './derive-identities.mjs';

// ---- Config -----------------------------------------------------------------
const DEFAULT_OWNER_IDENTITY_INDEX = 0;
const PROD_SOCIAL_CONTRACT_ID = 'EWR695MsqPUuW8EnTbYzD4KybNQD5n7CUDWydJYNg63F';
const PROD_PROFILE_CONTRACT_ID = 'FZSnZdKsLAuWxE7iZJq12eEz6xfGTgKPxK7uZJapTQxe';
const SDK_TIMEOUT_MS = 30000;
// -----------------------------------------------------------------------------

/** Compressed testnet WIFs, so a key echoed back inside an error never reaches the console. */
const WIF_PATTERN = /\b[c9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;

function describeErr(e) {
  if (!e) return String(e);
  const parts = [];
  for (const k of ['message', 'name', 'code', 'cause']) if (e[k] !== undefined) parts.push(`${k}=${e[k]}`);
  try { parts.push(`toString=${e.toString()}`); } catch {}
  try { parts.push(`json=${JSON.stringify(e)}`); } catch {}
  return parts.join(' | ').replace(WIF_PATTERN, '<redacted-key>');
}

function parseArgs(argv) {
  const args = {
    owner: null, only: null, ownerIndex: DEFAULT_OWNER_IDENTITY_INDEX, sourceNetwork: null,
    fromSocial: PROD_SOCIAL_CONTRACT_ID, fromProfile: PROD_PROFILE_CONTRACT_ID,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--owner': args.owner = argv[++i]; break;
      case '--only': args.only = argv[++i]; break;
      case '--owner-index': args.ownerIndex = Number(argv[++i]); break;
      case '--source-network': args.sourceNetwork = argv[++i]; break;
      case '--from-social': args.fromSocial = argv[++i]; break;
      case '--from-profile': args.fromProfile = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.only && !['social', 'profile'].includes(args.only)) {
    throw new Error(`--only takes "social" or "profile", got "${args.only}"`);
  }
  if (!Number.isInteger(args.ownerIndex) || args.ownerIndex < 0) {
    throw new Error('--owner-index takes a non-negative integer');
  }
  return args;
}

/** Chain metadata that belongs to the source contract, never to a fresh copy. */
const CHAIN_METADATA_KEYS = [
  'createdAt', 'updatedAt',
  'createdAtBlockHeight', 'updatedAtBlockHeight',
  'createdAtEpoch', 'updatedAtEpoch',
];

/**
 * Re-owns a fetched contract's full JSON so it can be published as a new one.
 *
 * `DataContract.fromJSON` is used rather than `new DataContract({ schemas })`
 * because the JSON form is the only one that round-trips *everything* the source
 * contract carries — `tokens`, `groups`, `config`, `keywords`, `description` —
 * and the constructor's `tokens` option only accepts live `TokenConfiguration`
 * handles, so a plain object read from JSON is rejected with "JS object
 * constructor name mismatch". Dropping the token block used to leave the copy
 * with `tokenCost` entries naming a token that did not exist.
 *
 * The id is seeded from the nonce; `contracts.publish` re-derives the real one at
 * broadcast time, so it is read back off the returned contract.
 */
function reownedContractJson(source, ownerId, identityNonce, platformVersion) {
  const json = source.toJSON(platformVersion);
  if (!json.documentSchemas || Object.keys(json.documentSchemas).length === 0) {
    throw new Error('Fetched contract exposes no document schemas');
  }
  json.ownerId = ownerId;
  json.id = DataContract.generateId(ownerId, identityNonce).toBase58();
  json.version = 1;
  for (const key of CHAIN_METADATA_KEYS) delete json[key];
  return json;
}

/** Publishes a re-owned clone of `source` as a brand-new contract owned by `ownerId`. */
async function publishContract(sdk, { label, source, ownerId, identityNonce, identityKey, signer }) {
  const platformVersion = PlatformVersion.current();
  const json = reownedContractJson(source, ownerId, identityNonce, platformVersion);
  const dataContract = DataContract.fromJSON(json, false, platformVersion);

  const tokenCount = Object.keys(json.tokens ?? {}).length;
  const tokenNote = tokenCount > 0 ? `, ${tokenCount} token(s)` : '';
  console.log(`publishing ${label} contract (${Object.keys(json.documentSchemas).length} document types${tokenNote}) …`);

  const published = await sdk.contracts.publish({ dataContract, identityKey, signer });
  const contractId = published.id.toBase58();
  const publishedTokens = Object.keys(published.tokens ?? {}).length;
  if (publishedTokens !== tokenCount) {
    throw new Error(`${label} contract published with ${publishedTokens} token(s), expected ${tokenCount}`);
  }
  console.log(`${label} contract published: ${contractId}`);
  return contractId;
}

// ---- Main -------------------------------------------------------------------

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: node scripts/register-test-contracts.mjs [--owner <identityId>] [--owner-index <n>] [--only social|profile]');
  console.error('       [--source-network testnet|mainnet|devnet] [--from-social <id>] [--from-profile <id>]');
  process.exit(1);
}

const ownerId = args.owner ?? loadIdentityIds()[0];
if (!ownerId) {
  console.error('No owner identity: pass --owner <identityId> or set E2E_IDENTITY_IDS in .env.testing');
  process.exit(1);
}

const published = {};
let sdk;
try {
  sdk = await connectSdk({ timeoutMs: SDK_TIMEOUT_MS });
  console.log(`owner=${ownerId} (seed index ${args.ownerIndex})`);

  // The source contracts can live on a different chain than the target: a devnet
  // starts empty, so its contracts are cloned from the testnet ones.
  const sourceNetwork = args.sourceNetwork ?? network();
  const sourceSdk = sourceNetwork === network()
    ? sdk
    : await connectSdk({ timeoutMs: SDK_TIMEOUT_MS, net: sourceNetwork });

  const signingKey = criticalAuthKey(deriveIdentityKeys(args.ownerIndex));
  const signer = new IdentitySigner();
  signer.addKeyFromWif(signingKey.wif);

  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) throw new Error(`Identity ${ownerId} not found on ${network()}`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  if (!identityKey) throw new Error(`Identity ${ownerId} has no key ${CRITICAL_AUTH_KEY_ID}`);
  const onChainPublicKeyHex = Buffer.from(identityKey.toObject().data).toString('hex');
  if (onChainPublicKeyHex !== signingKey.publicKeyHex) {
    throw new Error(
      `Identity ${ownerId} key ${CRITICAL_AUTH_KEY_ID} does not match the key derived at index ` +
      `${args.ownerIndex} — wrong --owner, wrong --owner-index, or wrong E2E_SEED_PHRASE`
    );
  }

  let identityNonce = ((await sdk.identities.nonce(ownerId)) ?? 0n) + 1n;

  if (args.only !== 'profile') {
    console.log(`fetching source social contract ${args.fromSocial} from ${sourceNetwork} …`);
    const sourceSocial = await sourceSdk.contracts.fetch(args.fromSocial);
    if (!sourceSocial) throw new Error(`Social contract ${args.fromSocial} not found on ${sourceNetwork}`);
    published.NEXT_PUBLIC_YAPPR_CONTRACT_ID = await publishContract(sdk, {
      label: 'social',
      source: sourceSocial,
      ownerId,
      identityNonce,
      identityKey,
      signer,
    });
    identityNonce += 1n;
  }

  if (args.only !== 'social') {
    console.log(`fetching source profile contract ${args.fromProfile} from ${sourceNetwork} …`);
    const sourceProfile = await sourceSdk.contracts.fetch(args.fromProfile);
    if (!sourceProfile) throw new Error(`Profile contract ${args.fromProfile} not found on ${sourceNetwork}`);
    published.NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID = await publishContract(sdk, {
      label: 'profile',
      source: sourceProfile,
      ownerId,
      identityNonce,
      identityKey,
      signer,
    });
  }
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}

console.log('');
console.log(`Paste into ${network() === 'devnet' ? '.env.devnet' : '.env.testing'}:`);
for (const [key, value] of Object.entries(published)) console.log(`${key}=${value}`);
if (published.NEXT_PUBLIC_YAPPR_CONTRACT_ID) {
  console.log('');
  console.log('Then set the YAPP direct-purchase price on the new social contract:');
  // NETWORK only applied to this process — repeat it or the price script
  // defaults to testnet and cannot see the freshly published contract.
  console.log(
    `  NETWORK=${network()} node scripts/set-yapp-price.mjs --contract ${published.NEXT_PUBLIC_YAPPR_CONTRACT_ID}` +
    ` --owner ${ownerId} --owner-index ${args.ownerIndex}`
  );
}

process.exit(0);
