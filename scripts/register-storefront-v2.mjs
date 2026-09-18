/**
 * Publishes `contracts/yappr-storefront-contract-v2.json` as a brand-new
 * contract on a devnet (see docs/STOREFRONT_V2.md).
 *
 * The v2 reviews are priced in YAPP through `tokenCost.create.contractId`, so
 * the JSON carries the placeholder `SOCIAL_CONTRACT_ID`, replaced here with
 * the deployment's social contract (`--social <id>`, default
 * NEXT_PUBLIC_YAPPR_CONTRACT_ID from .env.devnet).
 *
 * The owner is either an e2e bot (`--bot <index>`, keys from E2E_SEED_PHRASE)
 * or a seed-ledger persona (`--persona <idx>`, keys from
 * .seed-identities.local.json), so a throwaway battery contract does not need
 * the deployment maker's keys.
 *
 * Run:
 *   NETWORK=devnet node scripts/register-storefront-v2.mjs --dry-run
 *   NETWORK=devnet node scripts/register-storefront-v2.mjs --persona 203 [--social <id>]
 *   NETWORK=devnet node scripts/register-storefront-v2.mjs --bot 0 --owner <identityId>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataContract, IdentitySigner, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { REPO_ROOT, createSdkHandle, ledgerEntry, loadLedger, socialContractId, wifFromHex } from './seed/seed-lib.mjs';

const CONTRACT_FILE = join(REPO_ROOT, 'contracts', 'yappr-storefront-contract-v2.json');
const SOCIAL_PLACEHOLDER = 'SOCIAL_CONTRACT_ID';
const DRY_RUN_OWNER = '11111111111111111111111111111111';

/** The config block every yappr contract registers with on protocol 14. */
const CONFIG = {
  $formatVersion: '1',
  canBeDeleted: false,
  readonly: false,
  keepsHistory: false,
  documentsKeepHistoryContractDefault: false,
  documentsMutableContractDefault: true,
  documentsCanBeDeletedContractDefault: true,
  requiresIdentityEncryptionBoundedKey: null,
  requiresIdentityDecryptionBoundedKey: null,
  sizedIntegerTypes: true,
};

export function loadStorefrontV2Schemas(socialId) {
  const text = readFileSync(CONTRACT_FILE, 'utf8');
  if (!text.includes(`"${SOCIAL_PLACEHOLDER}"`)) {
    throw new Error(`${CONTRACT_FILE} no longer carries the ${SOCIAL_PLACEHOLDER} placeholder`);
  }
  // The meta-schema types `tokenCost.create.contractId` as a 32-byte array
  // (base58 is refused at registration even though the wasm validator takes it).
  const bytes = JSON.stringify(Array.from(bs58.decode(socialId)));
  return JSON.parse(text.replaceAll(`"${SOCIAL_PLACEHOLDER}"`, bytes));
}

function buildContract({ ownerId, identityNonce, socialId, platformVersion }) {
  const documentSchemas = loadStorefrontV2Schemas(socialId);
  const json = {
    $formatVersion: '1',
    id: DataContract.generateId(ownerId, identityNonce).toBase58(),
    ownerId,
    version: 1,
    config: CONFIG,
    documentSchemas,
  };
  return { dataContract: DataContract.fromJSON(json, true, platformVersion), documentSchemas };
}

function printAudit(documentSchemas) {
  for (const [name, schema] of Object.entries(documentSchemas)) {
    const flags = [
      `mutable=${schema.documentsMutable ?? 'default'}`,
      `canBeDeleted=${schema.canBeDeleted ?? 'default'}`,
      ...(schema.tokenCost?.create ? [`create=${schema.tokenCost.create.amount} YAPP`] : []),
    ];
    const indices = (schema.indices ?? []).map((index) => {
      const props = index.properties.map((entry) => Object.keys(entry)[0]).join(',');
      const marks = [
        index.unique ? 'u' : '',
        index.countable ? 'c' : '',
        index.averageable ? 'avg' : '',
        index.rankedCountable ? 'rc' : '',
        index.rankedAverageable ? 'ra' : '',
      ].filter(Boolean).join('/');
      return `${index.name}${marks ? `(${marks})` : ''}[${props}]`;
    });
    const refs = Object.entries(schema.properties)
      .filter(([, property]) => property.refersTo)
      .map(([property, { refersTo }]) => `${property}→${refersTo.documentType ?? refersTo.type}${refersTo.propertyAgreement ? `{${Object.keys(refersTo.propertyAgreement).join(',')}}` : ''}`);
    console.log(`  ${name.padEnd(18)} ${flags.join(' ')}`);
    console.log(`  ${''.padEnd(18)} ${indices.join(' ')}`);
    if (refs.length > 0) console.log(`  ${''.padEnd(18)} refersTo: ${refs.join(' ')}`);
  }
}

/** A signer for a seed-ledger persona (its CRITICAL auth key). */
export async function personaSigner(sdk, personaIdx) {
  const entry = ledgerEntry(loadLedger(), personaIdx);
  if (!entry) throw new Error(`persona ${personaIdx} is not in the seed ledger`);
  const identity = await sdk.identities.fetch(entry.identityId);
  if (!identity) throw new Error(`identity ${entry.identityId} (persona ${personaIdx}) not found on this devnet`);
  const identityKey = identity.getPublicKeyById(CRITICAL_AUTH_KEY_ID);
  const authKey = entry.identityKeys.find((key) => key.keyId === CRITICAL_AUTH_KEY_ID);
  if (!identityKey || !authKey) throw new Error(`persona ${personaIdx} has no CRITICAL auth key`);
  const signer = new IdentitySigner();
  signer.addKeyFromWif(wifFromHex(authKey.privateKeyHex));
  return { ownerId: entry.identityId, identityKey, signer, label: `persona${personaIdx}(${entry.handle})` };
}

function parseArgs(argv) {
  const args = { bot: null, persona: null, ownerId: null, social: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--bot': args.bot = Number(argv[++i]); break;
      case '--persona': args.persona = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--social': args.social = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.dryRun && (args.bot === null) === (args.persona === null)) {
    throw new Error('Pass exactly one of --bot <index> or --persona <idx>');
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error('Usage: NETWORK=devnet node scripts/register-storefront-v2.mjs (--bot <index> [--owner <id>] | --persona <idx>) [--social <id>] [--dry-run]');
    process.exit(1);
  }

  try {
    await ensureInitialized();
    const platformVersion = PlatformVersion.current();
    const socialId = args.social ?? socialContractId();

    if (args.dryRun) {
      const { dataContract, documentSchemas } = buildContract({ ownerId: DRY_RUN_OWNER, identityNonce: 1n, socialId, platformVersion });
      const roundTrip = dataContract.toJSON(platformVersion);
      console.log(`dry run: ${CONTRACT_FILE}`);
      console.log(`  document types : ${Object.keys(roundTrip.documentSchemas).length}`);
      console.log(`  YAPP contract  : ${socialId}`);
      printAudit(documentSchemas);
      process.exit(0);
    }

    const handle = createSdkHandle({ contractIds: [socialId] });
    const { protocolVersion } = await handle.connect();
    const sdk = handle.sdk;
    console.log(`connected (PV${protocolVersion})`);

    const owner = args.persona !== null
      ? await personaSigner(sdk, args.persona)
      : await (async () => {
          const resolved = resolveOwner({ botIndex: args.bot, ownerId: args.ownerId });
          const { identityKey, signer } = await signerFor(sdk, resolved);
          return { ownerId: resolved.ownerId, identityKey, signer, label: resolved.label };
        })();
    console.log(`owner=${owner.label}`);

    const identityNonce = ((await sdk.identities.nonce(owner.ownerId)) ?? 0n) + 1n;
    const { dataContract, documentSchemas } = buildContract({ ownerId: owner.ownerId, identityNonce, socialId, platformVersion });
    printAudit(documentSchemas);
    console.log(`publishing storefront v2 (${Object.keys(documentSchemas).length} document types, YAPP from ${socialId}) …`);
    const published = await sdk.contracts.publish({ dataContract, identityKey: owner.identityKey, signer: owner.signer });
    const contractId = published.id.toBase58();
    console.log(`storefront v2 published: ${contractId}`);
    console.log(`.env.devnet → NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID=${contractId}`);
    console.log(`battery     → NETWORK=devnet node scripts/verify-storefront-v2.mjs --contract ${contractId} …`);
    process.exit(0);
  } catch (e) {
    console.error('ERROR:', describeErr(e));
    process.exit(1);
  }
}
