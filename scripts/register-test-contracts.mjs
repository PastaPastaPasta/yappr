/**
 * One-time, manual registration of the dedicated /testing (or /devnet) data contracts.
 *
 * Publishes a fresh copy of the yappr social contract and of the unified profile
 * contract, owned by the e2e bot identity at derivation index 0 and signed with
 * its AUTHENTICATION/CRITICAL key. Re-running this is also the "reset test state"
 * mechanism: new contracts start empty, and the old ones are simply abandoned.
 *
 * Both schemas are read back from an already-deployed contract and re-published
 * verbatim under the new owner. (The checked-in
 * contracts/yappr-social-contract-actual.json predates current DPP validation —
 * its per-type `mutable` keys are rejected on registration — while the chain\'s
 * `schemas` getter returns the canonical registrable form.)
 *
 * The social contract's `tokens` block is carried over as well, so the copy
 * exercises the same YAPP-token-paid write path as the original. `tokenCost`
 * lives inside the document schemas and follows them; the token configuration
 * itself does not, and dropping it used to leave the copy with `tokenCost`
 * entries pointing at a token that did not exist. After publishing, set the
 * direct-purchase price with scripts/set-yapp-price.mjs.
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
import { DataContract, IdentitySigner } from '@dashevo/evo-sdk';
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

/** Reads the document schemas off a fetched DataContract. */
function schemasOf(dataContract) {
  const schemas = dataContract.schemas;
  if (!schemas || Object.keys(schemas).length === 0) {
    throw new Error('Fetched contract exposes no document schemas');
  }
  return schemas;
}

/**
 * Reads the token configurations off a fetched DataContract, keyed by contract
 * position. Returned verbatim: a `TokenConfiguration` is an opaque wasm handle,
 * and its change rules are expressed relative to the contract owner, so it
 * transfers to a new owner unchanged.
 */
function tokensOf(dataContract) {
  const tokens = dataContract.tokens;
  if (!tokens || Object.keys(tokens).length === 0) return null;
  return Object.fromEntries(Object.entries(tokens).map(([position, config]) => [Number(position), config]));
}

/**
 * Publishes `schemas` as a brand-new contract owned by `ownerId`.
 *
 * The identity nonce passed to the DataContract constructor only seeds a
 * provisional id — `contracts.publish` re-derives the real one from the nonce at
 * broadcast time, so the id is read back off the returned contract. The nonce is
 * tracked locally between publishes rather than re-read, because a read straight
 * after a broadcast can still return the pre-publish value.
 */
async function publishContract(sdk, { label, ownerId, schemas, tokens, identityNonce, identityKey, signer }) {
  const dataContract = new DataContract({ ownerId, identityNonce, schemas, ...(tokens ? { tokens } : {}) });
  const tokenNote = tokens ? `, ${Object.keys(tokens).length} token(s)` : '';
  console.log(`publishing ${label} contract (${Object.keys(schemas).length} document types${tokenNote}) …`);
  const published = await sdk.contracts.publish({ dataContract, identityKey, signer });
  const contractId = published.id.toBase58();
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
      ownerId,
      schemas: schemasOf(sourceSocial),
      tokens: tokensOf(sourceSocial),
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
      ownerId,
      schemas: schemasOf(sourceProfile),
      tokens: tokensOf(sourceProfile),
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
  console.log(
    `  node scripts/set-yapp-price.mjs --contract ${published.NEXT_PUBLIC_YAPPR_CONTRACT_ID}` +
    ` --owner ${ownerId} --owner-index ${args.ownerIndex}`
  );
}

process.exit(0);
