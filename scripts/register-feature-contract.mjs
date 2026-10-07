/**
 * Publishes any checked-in contract JSON from `contracts/` as a brand-new
 * contract on the network `NETWORK` names, owned by a seed-ledger persona or
 * an e2e bot.
 *
 * Every feature-contract re-cut (storefront, blog, DM, pollr, key-exchange,
 * blocks) goes through here, and so can a social cut: its `tokens` block (the
 * YAPP), `$formatVersion` and `version` are carried over from the file. Doctypes
 * priced in YAPP name the social contract through the `SOCIAL_CONTRACT_ID`
 * placeholder, which is replaced with the deployment's social contract id as a
 * 32-byte array (the form registration requires); a file without the
 * placeholder (the blocks contract, a social cut) needs no social id.
 *
 * A contract file may carry its own `config` block beside `documentSchemas`
 * (the beta.3 cuts do: `config.moderation` declares the banlist, the
 * suspension list and who edits them); a bare-schemas file gets the default
 * unmoderated config. `--moderators <id,id>` appoints identities beside the
 * owner at publish time; every one must exist on chain (41110), so they are
 * fetched before anything is signed.
 *
 * An ELECTED declaration registers with the network's interim (`withInterim`
 * in register-lib.mjs): on mainnet `notYetUsable`, elsewhere the file's own
 * (the committed social cut says `contractOwner`, which a devnet needs).
 * `--interim <kind>` overrides it (testnet's interim is undecided).
 *
 * Run:
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --dry-run
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blog-contract.json --persona 260
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file … --bot 0 --owner <identityId> --moderators <id,id>
 *   NETWORK=devnet node scripts/register-feature-contract.mjs --file yappr-blocks-contract.json --dry-run
 *   NETWORK=mainnet node scripts/register-feature-contract.mjs --file yappr-social-contract-v13.json --dry-run   # interim notYetUsable
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DataContract, IdentitySigner, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { CRITICAL_AUTH_KEY_ID } from './derive-identities.mjs';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';
import { REPO_ROOT, createSdkHandle, ledgerEntry, loadLedger, socialContractId, wifFromHex } from './seed/seed-lib.mjs';
import { network } from './sdk-env.mjs';
import { auditModeration, requireModeratorsExist, renderModeration, withInterim, withModerators } from './register-lib.mjs';

const SOCIAL_PLACEHOLDER = 'SOCIAL_CONTRACT_ID';
const DRY_RUN_OWNER = '11111111111111111111111111111111';

/**
 * The config a bare-schemas contract file registers with (no moderation) — the
 * beta.2 block, unchanged, so DM/pollr/vault/… republish exactly as before. A
 * moderated cut carries its own `config` (format version 2) in its file.
 */
const DEFAULT_CONFIG = {
  $formatVersion: '1', canBeDeleted: false, readonly: false, keepsHistory: false,
  documentsKeepHistoryContractDefault: false, documentsMutableContractDefault: true,
  documentsCanBeDeletedContractDefault: true, requiresIdentityEncryptionBoundedKey: null,
  requiresIdentityDecryptionBoundedKey: null, sizedIntegerTypes: true,
};

function contractPath(name) {
  return name.includes('/') || isAbsolute(name) ? name : join(REPO_ROOT, 'contracts', name);
}

/** Does the file price a doctype in the social contract's YAPP (and so need its id)? */
const needsSocialId = (file) => readFileSync(contractPath(file), 'utf8').includes(`"${SOCIAL_PLACEHOLDER}"`);

/** Loads a contract file, substituting the social contract id where priced. */
function loadContractFile(file, socialId) {
  const text = readFileSync(contractPath(file), 'utf8');
  const parsed = JSON.parse(socialId ? text.replaceAll(`"${SOCIAL_PLACEHOLDER}"`, JSON.stringify(Array.from(bs58.decode(socialId)))) : text);
  return parsed.documentSchemas
    ? { ...parsed, config: parsed.config ?? DEFAULT_CONFIG }
    : { documentSchemas: parsed, config: DEFAULT_CONFIG };
}

/** Loads a contract file's document schemas, substituting the social contract id where priced. */
export function loadSchemas(file, socialId) {
  return loadContractFile(file, socialId).documentSchemas;
}

function buildContract({ file, ownerId, identityNonce, socialId, platformVersion, moderators, interim }) {
  const source = loadContractFile(file, socialId);
  const config = withModerators(withInterim(source.config, { network: network(), interim }), moderators);
  const json = {
    $formatVersion: source.$formatVersion ?? '1',
    id: DataContract.generateId(ownerId, identityNonce).toBase58(),
    ownerId, version: source.version ?? 1, config, documentSchemas: source.documentSchemas,
    ...(source.tokens ? { tokens: source.tokens } : {}),
  };
  if (config.moderation) console.log(`  registers with moderation ${renderModeration(config.moderation)} on ${network()}`);
  const dataContract = DataContract.fromJSON(json, true, platformVersion);
  // A token block lost in assembly would only show up as an unpayable first post.
  const declaredTokens = Object.keys(source.tokens ?? {}).length;
  if (declaredTokens !== Object.keys(dataContract.toJSON(platformVersion).tokens ?? {}).length) throw new Error(`${file} declares ${declaredTokens} token(s), but the parsed contract carries a different number`);
  return { dataContract, documentSchemas: source.documentSchemas };
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
      ...(schema.moderatorAbilities ? [`moderators=${JSON.stringify(schema.moderatorAbilities)}`] : []),
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
      .map(([property, { refersTo }]) => `${property}→${refersTo.documentType ?? refersTo.type}${refersTo.type === 'deletableDocument' ? '?' : ''}${refersTo.where ? `{${Object.values(refersTo.where).join(',')}}` : ''}`);
    console.log(`  ${name.padEnd(18)} ${flags.join(' ')}`);
    console.log(`  ${''.padEnd(18)} ${indices.join(' ')}`);
    if (refs.length > 0) console.log(`  ${''.padEnd(18)} refersTo: ${refs.join(' ')}`);
    // 5.0.0-beta.1 reports `{ immutable, immutableWhen }`: the properties frozen
    // at creation, and those frozen while a condition holds (`{ property, when }`
    // entries, which replaced `immutableAllowSetting`).
    // The parse hands integer literals back as BigInt; both sides are rendered
    // with them as numbers, so `300000` in the file matches `300000n`.
    const conditionJson = (value) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v));
    const frozen = dataContract.documentTypeImmutableProperties(name);
    const frozenWhen = frozen.immutableWhen ?? {};
    const rendered = [...frozen.immutable, ...Object.entries(frozenWhen).map(([property, when]) => `${property}(when ${conditionJson(when)})`)];
    if (rendered.length > 0) console.log(`  ${''.padEnd(18)} immutable: ${rendered.join(' ')}`);
    // A declared list the parser did not pick up is the failure this audit
    // exists to catch: it would validate offline and be ignored on chain.
    // Compared by CONTENT, not length — a same-length list naming different
    // properties is the same silent divergence. `documentTypeImmutableProperties`
    // returns both sorted by property, so the declaration is sorted to match.
    const entries = schema.immutable ?? [];
    const declared = entries.filter((entry) => typeof entry === 'string').sort();
    const declaredWhen = entries.filter((entry) => typeof entry !== 'string').sort((a, b) => (a.property < b.property ? -1 : 1));
    const parsedWhen = Object.entries(frozenWhen).sort(([a], [b]) => (a < b ? -1 : 1));
    if (JSON.stringify(declared) !== JSON.stringify([...frozen.immutable].sort())
      || conditionJson(declaredWhen.map(({ property, when }) => [property, when])) !== conditionJson(parsedWhen)) {
      throw new Error(`${name}: schema declares immutable ${JSON.stringify(entries)} but the parsed contract reports ${conditionJson(frozen)}`);
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
  const args = { file: null, bot: null, persona: null, ownerId: null, social: null, moderators: [], interim: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--file': args.file = argv[++i]; break;
      case '--bot': args.bot = Number(argv[++i]); break;
      case '--persona': args.persona = Number(argv[++i]); break;
      case '--owner': args.ownerId = argv[++i]; break;
      case '--social': args.social = argv[++i]; break;
      case '--moderators': args.moderators = argv[++i].split(',').map((id) => id.trim()).filter(Boolean); break;
      case '--interim': args.interim = argv[++i]; break;
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
  console.error('Usage: NETWORK=devnet node scripts/register-feature-contract.mjs --file <json> (--bot <index> [--owner <id>] | --persona <idx>) [--social <id>] [--moderators <id,id>] [--interim <kind>] [--dry-run]');
  process.exit(1);
}

try {
  await ensureInitialized();
  const platformVersion = PlatformVersion.current();
  const socialId = needsSocialId(args.file) ? args.social ?? socialContractId() : null;
  const build = (ownerId, identityNonce) => buildContract({ file: args.file, ownerId, identityNonce, socialId, platformVersion, moderators: args.moderators, interim: args.interim });

  if (args.dryRun) {
    const { dataContract, documentSchemas } = build(DRY_RUN_OWNER, 1n);
    console.log(`dry run: ${contractPath(args.file)} — ${Object.keys(dataContract.toJSON(platformVersion).documentSchemas).length} document types${socialId ? `, YAPP from ${socialId}` : ''}`);
    printAudit(documentSchemas, dataContract);
    process.exit(0);
  }

  const handle = createSdkHandle({ contractIds: socialId ? [socialId] : [] });
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
  const { dataContract, documentSchemas } = build(owner.ownerId, identityNonce);
  printAudit(documentSchemas, dataContract);
  console.log(`publishing ${args.file} (${Object.keys(documentSchemas).length} document types) …`);
  const published = await sdk.contracts.publish({ dataContract, identityKey: owner.identityKey, signer: owner.signer });
  console.log(`published: ${published.id.toBase58()}`);
  process.exit(0);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
