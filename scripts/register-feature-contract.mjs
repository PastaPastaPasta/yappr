/**
 * Publishes any checked-in contract JSON from `contracts/` as a brand-new
 * contract on a devnet, owned by a seed-ledger persona or an e2e bot.
 *
 * Generalises scripts/register-storefront-v2.mjs: every feature contract
 * re-cut (storefront v2, blog v2, DM v4, pollr v4, key-exchange v3) goes
 * through here. Doctypes priced in YAPP name the social contract through the
 * `SOCIAL_CONTRACT_ID` placeholder, which is replaced with the deployment's
 * social contract id as a 32-byte array (the form registration requires).
 *
 * Run:
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract-v2.json --dry-run
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract-v2.json --persona 260
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file … --bot 0 --owner <identityId>
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DataContract, IdentitySigner, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { REPO_ROOT, createSdkHandle, ledgerEntry, loadLedger, socialContractId, wifFromHex } from './seed/seed-lib.mjs';

const SOCIAL_PLACEHOLDER = 'SOCIAL_CONTRACT_ID';
const DRY_RUN_OWNER = '11111111111111111111111111111111';

/** The config block every yappr contract registers with on protocol 14. */
const CONFIG = {
  $formatVersion: '1', canBeDeleted: false, readonly: false, keepsHistory: false,
  documentsKeepHistoryContractDefault: false, documentsMutableContractDefault: true,
  documentsCanBeDeletedContractDefault: true, requiresIdentityEncryptionBoundedKey: null,
  requiresIdentityDecryptionBoundedKey: null, sizedIntegerTypes: true,
};

function contractPath(name) {
  return name.includes('/') || isAbsolute(name) ? name : join(REPO_ROOT, 'contracts', name);
}

/** Loads a contract file's document schemas, substituting the social contract id where priced. */
export function loadSchemas(file, socialId) {
  const text = readFileSync(contractPath(file), 'utf8');
  const bytes = JSON.stringify(Array.from(bs58.decode(socialId)));
  const parsed = JSON.parse(text.replaceAll(`"${SOCIAL_PLACEHOLDER}"`, bytes));
  return parsed.documentSchemas ?? parsed;
}

function buildContract({ file, ownerId, identityNonce, socialId, platformVersion }) {
  const documentSchemas = loadSchemas(file, socialId);
  const json = {
    $formatVersion: '1',
    id: DataContract.generateId(ownerId, identityNonce).toBase58(),
    ownerId, version: 1, config: CONFIG, documentSchemas,
  };
  return { dataContract: DataContract.fromJSON(json, true, platformVersion), documentSchemas };
}

function printAudit(documentSchemas) {
  for (const [name, schema] of Object.entries(documentSchemas)) {
    const flags = [
      `mutable=${schema.documentsMutable ?? 'default'}`,
      `canBeDeleted=${schema.canBeDeleted ?? 'default'}`,
      ...(schema.indexOnly ? ['indexOnly'] : []),
      ...(schema.documentsKeepHistory ? ['keepHistory'] : []),
      ...(schema.tokenCost?.create ? [`create=${schema.tokenCost.create.amount} YAPP`] : []),
    ];
    const indices = (schema.indices ?? []).map((index) => {
      const props = index.properties.map((entry) => Object.keys(entry)[0]).join(',');
      const marks = [
        index.unique ? 'u' : '', index.countable ? 'c' : '', index.summable ? 'sum' : '', index.averageable ? 'avg' : '',
        index.rankedCountable ? 'rc' : '', index.rankedSummable ? 'rs' : '', index.rankedAverageable ? 'ra' : '',
        index.timeRange ? `tr${index.timeRange.ttl ? '+ttl' : ''}` : '', index.terminal ? `t:${index.terminal}` : '', index.preallocated ? 'pre' : '',
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
  const args = { file: null, bot: null, persona: null, ownerId: null, social: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--file': args.file = argv[++i]; break;
      case '--bot': args.bot = Number(argv[++i]); break;
      case '--persona': args.persona = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--social': args.social = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.file) throw new Error('--file <contract json under contracts/> is required');
  if (!args.dryRun && (args.bot === null) === (args.persona === null)) throw new Error('Pass exactly one of --bot <index> or --persona <idx>');
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: NETWORK=devnet node scripts/register-feature-contract.mjs --file <json> (--bot <index> [--owner <id>] | --persona <idx>) [--social <id>] [--dry-run]');
  process.exit(1);
}

try {
  await ensureInitialized();
  const platformVersion = PlatformVersion.current();
  const socialId = args.social ?? socialContractId();

  if (args.dryRun) {
    const { dataContract, documentSchemas } = buildContract({ file: args.file, ownerId: DRY_RUN_OWNER, identityNonce: 1n, socialId, platformVersion });
    console.log(`dry run: ${contractPath(args.file)} — ${Object.keys(dataContract.toJSON(platformVersion).documentSchemas).length} document types, YAPP from ${socialId}`);
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
  const { dataContract, documentSchemas } = buildContract({ file: args.file, ownerId: owner.ownerId, identityNonce, socialId, platformVersion });
  printAudit(documentSchemas);
  console.log(`publishing ${args.file} (${Object.keys(documentSchemas).length} document types) …`);
  const published = await sdk.contracts.publish({ dataContract, identityKey: owner.identityKey, signer: owner.signer });
  console.log(`published: ${published.id.toBase58()}`);
  process.exit(0);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
