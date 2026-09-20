/**
 * Publishes any checked-in contract JSON from `contracts/` as a brand-new
 * contract on a devnet, owned by a seed-ledger persona or an e2e bot.
 *
 * Every feature-contract re-cut (storefront, blog, DM, pollr, key-exchange)
 * goes through here. Doctypes priced in YAPP name the social contract through the
 * `SOCIAL_CONTRACT_ID` placeholder, which is replaced with the deployment's
 * social contract id as a 32-byte array (the form registration requires).
 *
 * A contract file may carry its own `config` block beside `documentSchemas`
 * (the beta.3 cuts do: `config.moderation` declares the banlist, the
 * suspension list and who edits them); a bare-schemas file gets the default
 * unmoderated config. `--moderators <id,id>` appoints identities beside the
 * owner at publish time; every one must exist on chain (41110), so they are
 * fetched before anything is signed.
 *
 * Run:
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --dry-run
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --persona 260
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file … --bot 0 --owner <identityId> --moderators <id,id>
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DataContract, IdentitySigner, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { REPO_ROOT, createSdkHandle, ledgerEntry, loadLedger, socialContractId, wifFromHex } from './seed/seed-lib.mjs';
import { auditModeration, requireModeratorsExist, withModerators } from './register-lib.mjs';

const SOCIAL_PLACEHOLDER = 'SOCIAL_CONTRACT_ID';
const DRY_RUN_OWNER = '11111111111111111111111111111111';

/** The config a bare-schemas contract file registers with (no moderation). */
const DEFAULT_CONFIG = {
  $formatVersion: '2', canBeDeleted: false, readonly: false, keepsHistory: false,
  documentsKeepHistoryContractDefault: false, documentsMutableContractDefault: true,
  documentsCanBeDeletedContractDefault: true, requiresIdentityEncryptionBoundedKey: null,
  requiresIdentityDecryptionBoundedKey: null, sizedIntegerTypes: true,
};

function contractPath(name) {
  return name.includes('/') || isAbsolute(name) ? name : join(REPO_ROOT, 'contracts', name);
}

/** Loads a contract file, substituting the social contract id where priced. */
function loadContractFile(file, socialId) {
  const text = readFileSync(contractPath(file), 'utf8');
  const bytes = JSON.stringify(Array.from(bs58.decode(socialId)));
  const parsed = JSON.parse(text.replaceAll(`"${SOCIAL_PLACEHOLDER}"`, bytes));
  return parsed.documentSchemas
    ? { documentSchemas: parsed.documentSchemas, config: parsed.config ?? DEFAULT_CONFIG }
    : { documentSchemas: parsed, config: DEFAULT_CONFIG };
}

/** Loads a contract file's document schemas, substituting the social contract id where priced. */
export function loadSchemas(file, socialId) {
  return loadContractFile(file, socialId).documentSchemas;
}

function buildContract({ file, ownerId, identityNonce, socialId, platformVersion, moderators }) {
  const { documentSchemas, config } = loadContractFile(file, socialId);
  const json = {
    $formatVersion: '1',
    id: DataContract.generateId(ownerId, identityNonce).toBase58(),
    ownerId, version: 1, config: withModerators(config, moderators), documentSchemas,
  };
  return { dataContract: DataContract.fromJSON(json, true, platformVersion), documentSchemas };
}

/**
 * Prints the built contract's shape, reading the frozen-property and reference
 * declarations back off the PARSED DataContract rather than the raw JSON: the
 * keywords are only recognised from protocol 14 onward, so a list that shows up
 * here is one consensus will actually enforce, while one that silently prints
 * empty means the keyword was not parsed at all.
 */
function printAudit(documentSchemas, dataContract) {
  for (const [name, schema] of Object.entries(documentSchemas)) {
    const flags = [
      `mutable=${schema.documentsMutable ?? 'default'}`,
      `canBeDeleted=${schema.canBeDeleted ?? 'default'}`,
      ...(schema.indexOnly ? ['indexOnly'] : []),
      ...(schema.documentsKeepHistory ? ['keepHistory'] : []),
      ...(schema.canBeDeletedByModerators ? ['moderatorDelete'] : []),
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
      .map(([property, { refersTo }]) => `${property}→${refersTo.documentType ?? refersTo.type}${refersTo.type === 'deletableDocument' ? '?' : ''}${refersTo.propertyAgreement ? `{${Object.keys(refersTo.propertyAgreement).join(',')}}` : ''}`);
    console.log(`  ${name.padEnd(18)} ${flags.join(' ')}`);
    console.log(`  ${''.padEnd(18)} ${indices.join(' ')}`);
    if (refs.length > 0) console.log(`  ${''.padEnd(18)} refersTo: ${refs.join(' ')}`);
    const frozen = dataContract.documentTypeImmutableProperties(name);
    if (frozen.immutable.length > 0) {
      const settable = new Set(frozen.immutableAllowSetting);
      const rendered = frozen.immutable.map((property) => (settable.has(property) ? `${property}(set-once)` : property));
      console.log(`  ${''.padEnd(18)} immutable: ${rendered.join(' ')}`);
    }
    // A declared list the parser did not pick up is the failure this audit
    // exists to catch: it would validate offline and be ignored on chain.
    // Compared by CONTENT, not length — a same-length list naming different
    // properties is the same silent divergence. `documentTypeImmutableProperties`
    // returns its arrays sorted, so the declaration is sorted to match.
    const declared = [...(schema.immutable ?? [])].sort();
    if (JSON.stringify(declared) !== JSON.stringify([...frozen.immutable].sort())) {
      throw new Error(`${name}: schema declares immutable ${JSON.stringify(declared)} but the parsed contract reports ${JSON.stringify(frozen.immutable)}`);
    }
  }
  auditModeration(documentSchemas, dataContract);
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
  const args = { file: null, bot: null, persona: null, ownerId: null, social: null, moderators: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--file': args.file = argv[++i]; break;
      case '--bot': args.bot = Number(argv[++i]); break;
      case '--persona': args.persona = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--social': args.social = argv[++i]; break;
      case '--moderators': args.moderators = argv[++i].split(',').map((id) => id.trim()).filter(Boolean); break;
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
  console.error('Usage: NETWORK=devnet node scripts/register-feature-contract.mjs --file <json> (--bot <index> [--owner <id>] | --persona <idx>) [--social <id>] [--moderators <id,id>] [--dry-run]');
  process.exit(1);
}

try {
  await ensureInitialized();
  const platformVersion = PlatformVersion.current();
  const socialId = args.social ?? socialContractId();

  if (args.dryRun) {
    const { dataContract, documentSchemas } = buildContract({ file: args.file, ownerId: DRY_RUN_OWNER, identityNonce: 1n, socialId, platformVersion, moderators: args.moderators });
    console.log(`dry run: ${contractPath(args.file)} — ${Object.keys(dataContract.toJSON(platformVersion).documentSchemas).length} document types, YAPP from ${socialId}`);
    printAudit(documentSchemas, dataContract);
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
  await requireModeratorsExist(sdk, args.moderators);
  const identityNonce = ((await sdk.identities.nonce(owner.ownerId)) ?? 0n) + 1n;
  const { dataContract, documentSchemas } = buildContract({ file: args.file, ownerId: owner.ownerId, identityNonce, socialId, platformVersion, moderators: args.moderators });
  printAudit(documentSchemas, dataContract);
  console.log(`publishing ${args.file} (${Object.keys(documentSchemas).length} document types) …`);
  const published = await sdk.contracts.publish({ dataContract, identityKey: owner.identityKey, signer: owner.signer });
  console.log(`published: ${published.id.toBase58()}`);
  process.exit(0);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
