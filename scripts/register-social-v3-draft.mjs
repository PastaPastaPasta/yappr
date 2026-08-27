/**
 * One-time, manual registration of the yappr social **v3-draft** contract on a
 * devnet (moutai by default).
 *
 * Publishes `contracts/yappr-social-contract-v3-draft.json` as a brand-new
 * contract. That file is the staging chain's canonical schemas plus exactly two
 * additions — `follow.followingId` and `postMention.mentionedUserId` both gain
 * `"refersTo": { "type": "identity" }` — so consensus refuses a follow or a
 * mention that points at an identity which does not exist.
 *
 * NOT the final v3 index set: the like/count index overhaul is still pending and
 * the post-target references stay polymorphic for now (see
 * PLAN_CONTRACT_V3_TOPOLOGY.md). Devnet is disposable; iterate freely.
 *
 * ## Network
 *
 * Devnet only, on purpose: `refersTo` needs protocol v14, testnet is still on
 * v13. Configured from the environment so this script needs no edit when the
 * devnet is re-genesised:
 *
 *   DEVNET_NAME     devnet name           (default: moutai)
 *   DAPI_ADDRESSES  comma-separated DAPI  (default: https://seed-{1..5}.<devnet>.networks.dash.org:1443)
 *
 * Non-trusted, proofs off: a devnet has no published quorum info to verify
 * against, so every query is served in trusted mode against the seeds above.
 *
 * ## The `tokens` block
 *
 * The v3-draft carries the YAPP token configuration (`post` costs 10 YAPP,
 * `reply` 3, `like`/`repost` 1). `new DataContract({ownerId, identityNonce,
 * schemas})` — the shape `register-pollr-contract.mjs` uses — cannot express it:
 * its optional `tokens` field is typed `Record<number, TokenConfiguration>` and
 * the wasm constructor rejects a plain object with "JS object constructor name
 * mismatch. Expected TokenConfiguration". Building real `TokenConfiguration`
 * instances would mean hand-assembling the whole nested wasm object graph
 * (ChangeControlRules, TokenDistributionRules, TokenMarketplaceRules, …).
 *
 * `DataContract.fromJSON(json, fullValidation, platformVersion)` does accept the
 * plain-object form and round-trips the token configuration intact, so that is
 * the path taken here. Verified locally against @dashevo/evo-sdk 4.2.0-dev.1.
 *
 * ## Owner
 *
 * `--maker` reads the contract-maker key file (see owner-keys.mjs); `--bot <n>`
 * derives from `E2E_SEED_PHRASE`. Identity **ids** are not derivable, and the
 * devnet ids differ from the testnet ones, so on devnet pass the id explicitly:
 *
 *   node scripts/register-social-v3-draft.mjs --bot 0 --owner <devnetIdentityId>
 *
 * `--dry-run` assembles and validates the contract locally and prints a summary
 * without touching the network.
 *
 * Run:  node scripts/register-social-v3-draft.mjs (--bot <index> | --maker) [--owner <identityId>] [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataContract, EvoSDK, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_FILE = join(REPO_ROOT, 'contracts', 'yappr-social-contract-v3-draft.json');
const SDK_TIMEOUT_MS = 30000;
const DEFAULT_DEVNET_NAME = 'moutai';
const DEFAULT_SEED_COUNT = 5;
/** Placeholder owner for `--dry-run`, so the contract can be assembled without an identity. */
const DRY_RUN_OWNER = '11111111111111111111111111111111';

// ---- Devnet SDK (inline on purpose: this script owns its network config) ----

/** `seed-1..5.<devnet>.networks.dash.org:1443` — the standard devnet seed layout. */
function defaultDevnetAddresses(devnetName) {
  return Array.from(
    { length: DEFAULT_SEED_COUNT },
    (_, i) => `https://seed-${i + 1}.${devnetName}.networks.dash.org:1443`
  );
}

/** Reads `DEVNET_NAME` / `DAPI_ADDRESSES` and builds a non-trusted devnet SDK. */
function devnetSdk() {
  const devnetName = process.env.DEVNET_NAME?.trim() || DEFAULT_DEVNET_NAME;
  const configured = (process.env.DAPI_ADDRESSES ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => (address.includes('://') ? address : `https://${address}`));
  const addresses = configured.length > 0 ? configured : defaultDevnetAddresses(devnetName);
  const sdk = new EvoSDK({
    network: 'devnet',
    devnetName,
    addresses,
    trusted: false,
    proofs: false,
    settings: { timeoutMs: SDK_TIMEOUT_MS },
  });
  return { sdk, devnetName, addresses };
}

// ---- Contract assembly ------------------------------------------------------

/**
 * Reads the v3-draft JSON and turns it into a publishable `DataContract` owned
 * by `ownerId`. `identityNonce` seeds a locally-derived id; the authoritative id
 * is whatever `contracts.publish` returns, which is what gets printed.
 */
function buildDraftContract({ ownerId, identityNonce, platformVersion }) {
  const file = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
  if (!file.documentSchemas || Object.keys(file.documentSchemas).length === 0) {
    throw new Error(`${CONTRACT_FILE} has no documentSchemas`);
  }
  const json = {
    $formatVersion: file.$formatVersion ?? '1',
    id: DataContract.generateId(ownerId, identityNonce).toBase58(),
    ownerId,
    version: file.version ?? 1,
    documentSchemas: file.documentSchemas,
    ...(file.config ? { config: file.config } : {}),
    ...(file.tokens ? { tokens: file.tokens } : {}),
  };
  return { dataContract: DataContract.fromJSON(json, true, platformVersion), file };
}

/** The `refersTo` declarations the draft is supposed to carry, for the log. */
function referenceSummary(documentSchemas) {
  const found = [];
  for (const [typeName, schema] of Object.entries(documentSchemas)) {
    for (const [propertyName, property] of Object.entries(schema.properties ?? {})) {
      if (property.refersTo) {
        found.push(`${typeName}.${propertyName} → ${JSON.stringify(property.refersTo)}`);
      }
    }
  }
  return found;
}

// ---- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { maker: false, botIndex: null, ownerId: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--maker': args.maker = true; break;
      case '--bot': args.botIndex = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.dryRun && args.maker === (args.botIndex !== null)) {
    throw new Error('Pass exactly one of --maker or --bot <index>');
  }
  if (args.botIndex !== null && !Number.isInteger(args.botIndex)) {
    throw new Error('--bot takes an integer index');
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error(
    'Usage: node scripts/register-social-v3-draft.mjs (--bot <index> | --maker) [--owner <identityId>] [--dry-run]'
  );
  process.exit(1);
}

try {
  await ensureInitialized();
  const platformVersion = PlatformVersion.current();

  if (args.dryRun) {
    // No identity, no network: prove the JSON assembles into a valid contract.
    const ownerId = args.ownerId ?? DRY_RUN_OWNER;
    const { dataContract, file } = buildDraftContract({ ownerId, identityNonce: 1n, platformVersion });
    const roundTrip = dataContract.toJSON(platformVersion);
    console.log(`dry run: ${CONTRACT_FILE}`);
    console.log(`  document types : ${Object.keys(roundTrip.documentSchemas).length}`);
    const tokenPositions = Object.keys(roundTrip.tokens ?? {});
    console.log(
      tokenPositions.length > 0
        ? `  tokens         : ${tokenPositions.length} (positions ${tokenPositions.join(', ')})`
        : '  tokens         : NONE — the token block was lost in assembly'
    );
    console.log(`  provisional id : ${roundTrip.id}`);
    for (const line of referenceSummary(file.documentSchemas)) console.log(`  refersTo       : ${line}`);
    const { devnetName, addresses } = devnetSdk();
    console.log(`  would publish to devnet "${devnetName}" via ${addresses.join(', ')}`);
    process.exit(0);
  }

  const owner = resolveOwner(args);
  const { sdk, devnetName, addresses } = devnetSdk();
  await sdk.connect();
  console.log(`connected to devnet "${devnetName}" (${addresses.length} addresses); owner=${owner.label}`);

  const { identityKey, signer } = await signerFor(sdk, owner);
  const identityNonce = ((await sdk.identities.nonce(owner.ownerId)) ?? 0n) + 1n;

  const { dataContract, file } = buildDraftContract({
    ownerId: owner.ownerId,
    identityNonce,
    platformVersion,
  });
  for (const line of referenceSummary(file.documentSchemas)) console.log(`refersTo: ${line}`);

  console.log(`publishing yappr social v3-draft (${Object.keys(file.documentSchemas).length} document types) …`);
  const published = await sdk.contracts.publish({ dataContract, identityKey, signer });
  const contractId = published.id.toBase58();

  // A dropped token block would only show up much later, as "insufficient token
  // balance" on the first post, so check it here while the contract is fresh.
  const publishedTokens = published.toJSON(platformVersion).tokens;
  const tokenCount = publishedTokens ? Object.keys(publishedTokens).length : 0;
  console.log(`yappr social v3-draft published: ${contractId}`);
  console.log(`token configurations on the published contract: ${tokenCount}`);
  if (tokenCount === 0) {
    console.log('WARNING: the token block did not survive publication — posts will not be payable.');
  }
  console.log('');
  console.log(`.env.devnet → NEXT_PUBLIC_YAPPR_CONTRACT_ID=${contractId}`);
  console.log(`battery     → node scripts/verify-refersto.mjs --contract ${contractId} …`);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
process.exit(0);
