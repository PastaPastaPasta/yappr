/**
 * One-time, manual registration of the dedicated /testing data contracts.
 *
 * Publishes a fresh copy of the yappr social contract and of the unified profile
 * contract, owned by the e2e bot identity at derivation index 0 and signed with
 * its AUTHENTICATION/CRITICAL key. Re-running this is also the "reset test state"
 * mechanism: new contracts start empty, and the old ones are simply abandoned.
 *
 * Both schemas are read back from the deployed production contracts and
 * re-published verbatim under the new owner. (The checked-in
 * contracts/yappr-social-contract-actual.json predates current DPP validation —
 * its per-type `mutable` keys are rejected on registration — while the chain\'s
 * `schemas` getter returns the canonical registrable form.)
 *
 * Run:
 *   node scripts/register-test-contracts.mjs [--owner <identityId>] [--only social|profile]
 *
 * The owner defaults to the first entry of E2E_IDENTITY_IDS in .env.testing.
 * Prints the `.env.testing` lines to paste when it finishes.
 */
import { DataContract, EvoSDK, IdentitySigner } from '@dashevo/evo-sdk';
import {
  CRITICAL_AUTH_KEY_ID,
  criticalAuthKey,
  deriveIdentityKeys,
  loadIdentityIds,
} from './derive-identities.mjs';

// ---- Config -----------------------------------------------------------------
const OWNER_IDENTITY_INDEX = 0;
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
  const args = { owner: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--owner': args.owner = argv[++i]; break;
      case '--only': args.only = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.only && !['social', 'profile'].includes(args.only)) {
    throw new Error(`--only takes "social" or "profile", got "${args.only}"`);
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
 * Publishes `schemas` as a brand-new contract owned by `ownerId`.
 *
 * The identity nonce passed to the DataContract constructor only seeds a
 * provisional id — `contracts.publish` re-derives the real one from the nonce at
 * broadcast time, so the id is read back off the returned contract. The nonce is
 * tracked locally between publishes rather than re-read, because a read straight
 * after a broadcast can still return the pre-publish value.
 */
async function publishContract(sdk, { label, ownerId, schemas, identityNonce, identityKey, signer }) {
  const dataContract = new DataContract({ ownerId, identityNonce, schemas });
  console.log(`publishing ${label} contract (${Object.keys(schemas).length} document types) …`);
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
  console.error('Usage: node scripts/register-test-contracts.mjs [--owner <identityId>] [--only social|profile]');
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
  sdk = EvoSDK.testnetTrusted({ settings: { timeoutMs: SDK_TIMEOUT_MS } });
  await sdk.connect();
  console.log(`connected to testnet; owner=${ownerId}`);

  const signingKey = criticalAuthKey(deriveIdentityKeys(OWNER_IDENTITY_INDEX));
  const signer = new IdentitySigner();
  signer.addKeyFromWif(signingKey.wif);

  const identity = await sdk.identities.fetch(ownerId);
  if (!identity) throw new Error(`Identity ${ownerId} not found on testnet`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  if (!identityKey) throw new Error(`Identity ${ownerId} has no key ${CRITICAL_AUTH_KEY_ID}`);
  const onChainPublicKeyHex = Buffer.from(identityKey.toObject().data).toString('hex');
  if (onChainPublicKeyHex !== signingKey.publicKeyHex) {
    throw new Error(
      `Identity ${ownerId} key ${CRITICAL_AUTH_KEY_ID} does not match the key derived at index ` +
      `${OWNER_IDENTITY_INDEX} — wrong --owner or wrong E2E_SEED_PHRASE`
    );
  }

  let identityNonce = ((await sdk.identities.nonce(ownerId)) ?? 0n) + 1n;

  if (args.only !== 'profile') {
    console.log(`fetching production social contract ${PROD_SOCIAL_CONTRACT_ID} …`);
    const prodSocial = await sdk.contracts.fetch(PROD_SOCIAL_CONTRACT_ID);
    if (!prodSocial) throw new Error(`Social contract ${PROD_SOCIAL_CONTRACT_ID} not found`);
    published.NEXT_PUBLIC_YAPPR_CONTRACT_ID = await publishContract(sdk, {
      label: 'social',
      ownerId,
      schemas: schemasOf(prodSocial),
      identityNonce,
      identityKey,
      signer,
    });
    identityNonce += 1n;
  }

  if (args.only !== 'social') {
    console.log(`fetching production profile contract ${PROD_PROFILE_CONTRACT_ID} …`);
    const prodProfile = await sdk.contracts.fetch(PROD_PROFILE_CONTRACT_ID);
    if (!prodProfile) throw new Error(`Profile contract ${PROD_PROFILE_CONTRACT_ID} not found`);
    published.NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID = await publishContract(sdk, {
      label: 'profile',
      ownerId,
      schemas: schemasOf(prodProfile),
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
console.log('Paste into .env.testing:');
for (const [key, value] of Object.entries(published)) console.log(`${key}=${value}`);

process.exit(0);
