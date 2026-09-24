/**
 * Offline full-validation parse of a contract JSON against the installed
 * wasm DPP — no network, no keys, no broadcast.
 *
 * This is the cheap gate that a `contracts/*.json` file would actually be
 * ACCEPTED at registration: `DataContract.fromJSON(json, true, <latest>)` runs
 * the same structural parser the chain runs, so a grammar mistake (a bad
 * `propertyAgreement` pair, an `immutable` entry naming a system field, a
 * `rangeCountable`/`countable` contradiction, a lookup whose key can move) fails
 * here rather than after a funded state transition.
 *
 * What the wasm parse does NOT run (measured on 4.2.0-beta.4, see
 * `scripts/contract-probes.mjs`): the JSON meta-schema (an unknown keyword
 * parses; checked here with ajv against the vendored rs-dpp meta-schema v3),
 * the 20,480-byte state transition cap (measured here on the create
 * transition, budget 20,000 signed), the moderation declaration's pure-data rules
 * (`ContractModerationConfig::validate`, 10900: election windows, the
 * moderated set, the abilities each list backs) and the per-document reference
 * budget. Those run in the create transition's basic-structure validation on
 * the node. This script therefore re-checks the ones Yappr's cuts depend on
 * (`auditNodeRules`), and `--probes` runs the negative probes that
 * record which refusals are local and which only the node makes.
 *
 * The `id`/`ownerId` are placeholders: neither participates in schema
 * validation, and nothing is signed or published.
 *
 * Feature contracts price their documents in the SOCIAL contract's YAPP through
 * `tokenCost.create.contractId: "SOCIAL_CONTRACT_ID"`; the placeholder is
 * substituted with a valid 32-byte id, exactly as the registration script does.
 * A bare-schemas file (profile, DM, pollr, …) registers with the unmoderated
 * default config, as `register-feature-contract.mjs` publishes it.
 *
 * Run:
 *   node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v9.json
 *   node scripts/validate-contract-offline.mjs <file> --immutable post,reply
 *   node scripts/validate-contract-offline.mjs <file> --strict-size   # size over 20,000 B fails
 *   node scripts/validate-contract-offline.mjs --probes
 */
import { readFileSync } from 'node:fs';
import { DataContract, DataContractCreateTransition, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import bs58 from 'bs58';
import { renderModeration } from './register-lib.mjs';
import { CREATE_TRANSITION_BUDGET, auditNodeRules, createTransitionSize, metaSchemaProblems, runContractProbes } from './contract-probes.mjs';

/** Any valid 32-byte identifier; schema validation never looks at it. */
const PLACEHOLDER_ID = '11111111111111111111111111111111';
const SOCIAL_PLACEHOLDER = 'SOCIAL_CONTRACT_ID';

/** The config a bare-schemas file registers with (register-feature-contract.mjs DEFAULT_CONFIG). */
const DEFAULT_CONFIG = {
  $formatVersion: '1', canBeDeleted: false, readonly: false, keepsHistory: false,
  documentsKeepHistoryContractDefault: false, documentsMutableContractDefault: true,
  documentsCanBeDeletedContractDefault: true, requiresIdentityEncryptionBoundedKey: null,
  requiresIdentityDecryptionBoundedKey: null, sizedIntegerTypes: true,
};

function parseArgs(argv) {
  const flagIndex = argv.indexOf('--immutable');
  const immutable = flagIndex === -1 ? [] : (argv[flagIndex + 1] ?? '').split(',').filter(Boolean);
  const probes = argv.includes('--probes');
  // --strict-size: over the 20,000-byte headroom budget is a FAILURE, not a
  // warning (build-v9-contract.py --self-test runs this on its own cut).
  const strictSize = argv.includes('--strict-size');
  // Skip the flag AND its value, so `--immutable post,reply <file>` does not
  // resolve the positional to "post,reply".
  const file = argv.find((arg, index) => !arg.startsWith('--') && (flagIndex === -1 || index !== flagIndex + 1));
  if (!file && !probes) throw new Error('usage: node scripts/validate-contract-offline.mjs <contract.json> [--immutable a,b] | --probes');
  return { file, immutable, probes, strictSize };
}

/** A contract file in the shape registration assembles it: schemas, config (file or default), tokens. */
function loadContractSource(file) {
  const bytes = JSON.stringify(Array.from(bs58.decode(PLACEHOLDER_ID)));
  const raw = JSON.parse(readFileSync(file, 'utf8').replaceAll(`"${SOCIAL_PLACEHOLDER}"`, bytes));
  return raw.documentSchemas
    ? { ...raw, config: raw.config ?? DEFAULT_CONFIG }
    : { documentSchemas: raw, config: DEFAULT_CONFIG };
}

/** The same assembly `scripts/register-social-v3-draft.mjs` publishes with. */
function parseContract(source, platformVersion = PlatformVersion.latest()) {
  return DataContract.fromJSON({
    $formatVersion: source.$formatVersion ?? '1',
    id: PLACEHOLDER_ID,
    ownerId: PLACEHOLDER_ID,
    version: source.version ?? 1,
    documentSchemas: source.documentSchemas,
    config: source.config,
    ...(source.tokens ? { tokens: source.tokens } : {}),
  }, true, platformVersion);
}

function validateFile(file, immutable, strictSize) {
  const source = loadContractSource(file);
  const platformVersion = PlatformVersion.latest();
  const contract = parseContract(source, platformVersion);
  console.log(`OK  ${file} parses under FULL validation`);
  console.log(`    platform version: ${platformVersion.version} (${platformVersion.__type})`);
  console.log(`    document types:   ${Object.keys(source.documentSchemas).length}`);

  // `documentImmutableProperties` is a Map of every type that freezes
  // something; it is empty below protocol 14 even when the raw schema carries
  // the keywords, so a non-empty map is itself the protocol-14 proof.
  console.log(`    freezing types:   ${[...contract.documentImmutableProperties.keys()].join(', ') || '(none)'}`);
  // Protocol-14 grammar, read back off the PARSED contract: a keyword the
  // parser dropped would validate here and be ignored on chain.
  const moderation = contract.config.moderation;
  console.log(`    moderation:       ${moderation ? renderModeration(moderation) : '(none)'}`);
  if (source.config.moderation && !moderation) {
    throw new Error('the file declares config.moderation but the parse carries none — is config.$formatVersion "2"?');
  }
  if (source.config.moderation?.warnings === true && moderation?.warnings !== true) {
    throw new Error('the file keeps a warning list but the parsed config does not');
  }
  const moderatorDeletable = new Set(Object.entries(source.documentSchemas)
    .filter(([, schema]) => schema.canBeDeletedByModerators)
    .map(([name]) => name));
  console.log(`    moderator delete: ${[...moderatorDeletable].join(', ') || '(none)'}`);
  const distinct = [...contract.documentDistinctFrom].flatMap(([type, list]) => list.map((d) => `${type}.${d.path}≠${d.distinctFrom}`));
  console.log(`    distinctFrom:     ${distinct.join(', ') || '(none)'}`);
  const typed = [...contract.documentTypedArrays].flatMap(([type, list]) => list.map((a) => `${type}.${a.path}[${a.items.type}≤${a.maxItems}${a.items.refersTo ? `→${a.items.refersTo.type}` : ''}]`));
  console.log(`    typed arrays:     ${typed.join(', ') || '(none)'}`);
  // `documentTypeReferences` reports the type consensus enforces, so a
  // permanentDocument reference at a moderator-deletable type — refused at
  // registration with 40122 — shows up here first.
  for (const referrer of Object.keys(source.documentSchemas)) {
    for (const reference of contract.documentTypeReferences(referrer)) {
      if (reference.path === '$ownerId') console.log(`    ownerRefersTo:    ${referrer} → ${reference.type} ${reference.documentType}${reference.lookup ? ` via ${reference.lookup.index}` : ''}`);
      else if (reference.lookup) console.log(`    lookup ref:       ${referrer}.${reference.path} → ${reference.type} ${reference.documentType} via ${reference.lookup.index} ${JSON.stringify(reference.lookup.keys)}`);
      if (moderatorDeletable.has(reference.documentType) && reference.type !== 'deletableDocument') {
        throw new Error(`${referrer}.${reference.path} references moderator-deletable "${reference.documentType}" as ${reference.type}`);
      }
    }
  }
  // The node-side rules the wasm parse skips, for the declarations Yappr uses.
  const size = createTransitionSize(contract, { DataContractCreateTransition, platformVersion });
  console.log(`    create size:      ~${size.bytes} B signed (budget ${CREATE_TRANSITION_BUDGET}, cap 20480)`);
  const meta = metaSchemaProblems(source);
  console.log(`    meta-schema v3:   ${meta.length === 0 ? 'ok' : `${meta.length} problem(s)`}`);
  const problems = [...auditNodeRules(source), ...meta];
  // Over the cap is a refusal; between the budget and the cap is a warning
  // (v8, published at ~20,300 B, sits there: any growth would not register).
  if (size.overCap) problems.push(`the create transition is ~${size.bytes} B signed, over the 20480 B cap (rs-dapi refuses it, Drive 10602)`);
  else if (!size.fits && strictSize) problems.push(`the create transition is ~${size.bytes} B signed, over the ${CREATE_TRANSITION_BUDGET} B headroom budget (--strict-size)`);
  else if (!size.fits) console.log(`WARN  the create transition is ~${size.bytes} B signed, inside the cap but over the ${CREATE_TRANSITION_BUDGET} B headroom budget`);
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length > 0) throw new Error(`${problems.length} rule(s) the node would refuse (see above)`);
  for (const documentType of immutable) {
    console.log(`    ${documentType}: ${JSON.stringify(contract.documentTypeImmutableProperties(documentType))}`);
  }
}

async function main() {
  // The wasm module backs every class below; nothing works before it loads.
  await ensureInitialized();
  const { file, immutable, probes, strictSize } = parseArgs(process.argv.slice(2));
  if (file) validateFile(file, immutable, strictSize);
  if (probes) {
    const platformVersion = PlatformVersion.latest();
    const sizeOf = (contract) => createTransitionSize(contract, { DataContractCreateTransition, platformVersion });
    const failed = runContractProbes({ loadContractSource, parseContract, sizeOf });
    if (failed > 0) throw new Error(`${failed} probe(s) did not behave as recorded`);
  }
}

try {
  await main();
} catch (error) {
  // WASM rejections arrive as objects whose useful text is on `message`; the
  // default uncaught-exception dump would print the minified bundle instead.
  console.error(`FAIL  ${error?.message ?? error}`);
  if (error?.code !== undefined) console.error(`      consensus code: ${error.code}`);
  process.exit(1);
}
