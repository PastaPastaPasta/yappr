/**
 * Offline full-validation parse of a contract JSON against the installed
 * wasm DPPs — no network, no keys, no broadcast.
 *
 * This is the cheap gate that a `contracts/*.json` file would actually be
 * ACCEPTED at registration. It parses the file twice with
 * `DataContract.fromJSON(json, true, <latest>)`:
 *
 *   1. through the wasm-sdk (`@dashevo/evo-sdk`), the package that signs and
 *      publishes it: the structural parser (a bad `where` pair, a `findBy` that
 *      names no unique index, an `immutable` entry naming a system field, a
 *      `changeFields` entry a reference reads, a `skipIfAbsent` the type cannot
 *      honour);
 *   2. through `@dashevo/wasm-dpp2` (a devDependency), the same parser built
 *      WITH rs-dpp's `validation` feature: the JSON meta-schema and the index
 *      shape rules. The wasm-sdk has neither, and it silently DROPS a doctype
 *      key the meta-schema refuses: on 4.2.0-beta.7 a leftover
 *      `canBeDeletedByModerators` parses there, the type loses its moderator
 *      delete, and the node refuses the registration (10101). A green wasm-sdk
 *      parse alone proves nothing about such keys.
 *
 * What neither parse runs (`scripts/contract-probes.mjs` records each): the
 * 20,480-byte state transition cap (measured here on the create transition,
 * budget 20,000 signed), the moderation declaration's pure-data rules
 * (`ContractModerationConfig::validate`, 10900: election windows, the
 * moderated set, the abilities each list or type backs) and the one reference
 * kind a reference's target admits (40122/40131/40143/40144). Those run on
 * the node, so
 * `auditNodeRules` re-checks the ones Yappr's cuts depend on, together with
 * the index shapes, and `--probes` runs the negative probes.
 *
 * The `id`/`ownerId` are placeholders: neither participates in schema
 * validation, and nothing is signed or published.
 *
 * Feature contracts price their documents in the SOCIAL contract's YAPP through
 * `tokenCost.create.contractId: "SOCIAL_CONTRACT_ID"`; the placeholder is
 * substituted with another valid 32-byte id, as the registration script
 * substitutes the published social id.
 * A bare-schemas file (profile, DM, pollr, …) registers with the unmoderated
 * default config, as `register-feature-contract.mjs` publishes it.
 *
 * Run:
 *   node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v10.json --strict-size
 *   node scripts/validate-contract-offline.mjs <file> --immutable post,reply
 *   node scripts/validate-contract-offline.mjs <file> --network mainnet   # mainnet's one-day election-window floor (default devnet: 0)
 *                                                                         # and its registration: an elected interim becomes notYetUsable
 *   node scripts/validate-contract-offline.mjs <file> --interim noModeration   # validate another interim than the network's
 *   node scripts/validate-contract-offline.mjs <file> --cost              # documentCreateCost per type and per social write (credits and ¢)
 *   node scripts/validate-contract-offline.mjs --probes        # negative probes, update probes through wasm-dpp2 validateUpdate
 *   node scripts/validate-contract-offline.mjs --constraints   # propertyConstraints accept/refuse cases (wasm-sdk checkDocumentPropertyConstraints)
 */
import { readFileSync } from 'node:fs';
import { DataContract, DataContractCreateTransition, Document, PlatformVersion, documentCreateCost, ensureInitialized } from '@dashevo/evo-sdk';
import initWasmDpp2, { DataContract as NodeRulesDataContract, PlatformVersion as NodeRulesPlatformVersion } from '@dashevo/wasm-dpp2';
import { renderModeration, withInterim } from './register-lib.mjs';
import { CREATE_TRANSITION_BUDGET, STATE_TRANSITION_CAP, auditNodeRules, createTransitionSize, metaSchemaProblems, runContractProbes } from './contract-probes.mjs';
import { runConstraintCases } from './property-constraint-cases.mjs';

/** Any valid 32-byte identifier; schema validation never looks at it. */
const PLACEHOLDER_ID = '11111111111111111111111111111111';
const SOCIAL_PLACEHOLDER = 'SOCIAL_CONTRACT_ID';
/**
 * What `SOCIAL_CONTRACT_ID` becomes: any id OTHER than the contract's own, as
 * on chain. wasm-dpp2 refuses a token cost naming the declaring contract's id
 * ("redundant because it is targeting the current contract").
 */
const SOCIAL_STAND_IN = Array(32).fill(7);

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
  const constraints = argv.includes('--constraints');
  const cost = argv.includes('--cost');
  // --strict-size: over the 20,000-byte headroom budget is a FAILURE, not a
  // warning. Run it on every social cut before registering it.
  const strictSize = argv.includes('--strict-size');
  const networkIndex = argv.indexOf('--network');
  const networkEquals = argv.find((arg) => arg.startsWith('--network='));
  const network = networkEquals ? networkEquals.slice('--network='.length) : networkIndex === -1 ? 'devnet' : argv[networkIndex + 1];
  if (!['devnet', 'testnet', 'mainnet'].includes(network)) throw new Error(`--network must be devnet, testnet or mainnet (got "${network}")`);
  const interimIndex = argv.indexOf('--interim');
  const interim = interimIndex === -1 ? undefined : argv[interimIndex + 1];
  // Skip each flag's value, so `--immutable post,reply <file>` does not
  // resolve the positional to "post,reply".
  const valueIndexes = new Set([flagIndex, networkIndex, interimIndex].filter((index) => index !== -1).map((index) => index + 1));
  const file = argv.find((arg, index) => !arg.startsWith('--') && !valueIndexes.has(index));
  if (!file && !probes && !constraints) throw new Error('usage: node scripts/validate-contract-offline.mjs <contract.json> [--network n] [--interim kind] [--immutable a,b] [--cost] | --probes | --constraints');
  return { file, immutable, probes, constraints, cost, strictSize, network, interim };
}

/**
 * A contract file in the shape registration assembles it on `network`:
 * schemas, config (file or default, with the network's elected interim, see
 * `withInterim`), tokens.
 */
function loadContractSource(file, { network, interim } = {}) {
  const raw = JSON.parse(readFileSync(file, 'utf8').replaceAll(`"${SOCIAL_PLACEHOLDER}"`, JSON.stringify(SOCIAL_STAND_IN)));
  const source = raw.documentSchemas
    ? { ...raw, config: raw.config ?? DEFAULT_CONFIG }
    : { documentSchemas: raw, config: DEFAULT_CONFIG };
  return { ...source, config: withInterim(source.config, { network, interim }) };
}

/** The JSON `scripts/register-social-v3-draft.mjs` publishes. */
function contractJson(source) {
  return {
    $formatVersion: source.$formatVersion ?? '1',
    id: PLACEHOLDER_ID,
    ownerId: PLACEHOLDER_ID,
    version: source.version ?? 1,
    documentSchemas: source.documentSchemas,
    config: source.config,
    ...(source.tokens ? { tokens: source.tokens } : {}),
  };
}

/** The wasm-sdk parse: the package that signs and publishes the contract. */
function parseContract(source, platformVersion = PlatformVersion.latest()) {
  return DataContract.fromJSON(contractJson(source), true, platformVersion);
}

/** The wasm-dpp2 parse: the same parser with rs-dpp's `validation` (meta-schema, index shapes). */
function parseWithNodeRules(source) {
  return NodeRulesDataContract.fromJSON(contractJson(source), true, NodeRulesPlatformVersion.latest());
}

/**
 * Why a data contract update from `stored` to `updated` would be refused, as
 * `<code> <message>` lines ([] = accepted): wasm-dpp2's `validateUpdate`, the
 * code consensus runs on an update transition. No state is read.
 */
function updateRefusals(stored, updated) {
  const platformVersion = NodeRulesPlatformVersion.latest();
  const before = NodeRulesDataContract.fromJSON(contractJson(stored), true, platformVersion);
  const after = NodeRulesDataContract.fromJSON(contractJson(updated), true, platformVersion);
  return before.validateUpdate(after, undefined, platformVersion).map((error) => `${error.code} ${error.message}`);
}

const describeReference = (reference) => {
  const findBy = reference.findBy ? ` findBy ${JSON.stringify(reference.findBy)}` : '';
  const where = reference.where ? ` where ${JSON.stringify(reference.where)}` : '';
  const foreign = reference.contractId && String(reference.contractId) !== PLACEHOLDER_ID ? ` in ${reference.contractId}` : '';
  return `${reference.type} ${reference.documentType}${foreign}${findBy}${where}`;
};

function validateFile(file, { immutable, strictSize, network, interim }) {
  const source = loadContractSource(file, { network, interim });
  const platformVersion = PlatformVersion.latest();
  const contract = parseContract(source, platformVersion);
  console.log(`OK  ${file} parses under FULL validation (wasm-sdk)`);
  parseWithNodeRules(source);
  console.log(`OK  ${file} parses under the node rules (wasm-dpp2: meta-schema + index shapes)`);
  console.log(`    platform version: ${platformVersion.version} (${platformVersion.__type})`);
  const declaredInterim = loadContractSource(file).config.moderation?.moderators?.interim?.$type;
  const renderedInterim = source.config.moderation?.moderators?.interim?.$type;
  if (declaredInterim !== renderedInterim) console.log(`    interim:          ${renderedInterim} as registered on ${network} (the file declares ${declaredInterim})`);
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
  const abilities = Object.entries(source.documentSchemas)
    .filter(([, schema]) => schema.moderatorAbilities)
    .map(([name, schema]) => `${name} ${JSON.stringify(schema.moderatorAbilities)}`);
  console.log(`    moderator abilities: ${abilities.join('; ') || '(none)'}`);
  const distinct = [...contract.documentDistinctFrom].flatMap(([type, list]) => list.map((d) => `${type}.${d.path}≠${d.distinctFrom}`));
  console.log(`    distinctFrom:     ${distinct.join(', ') || '(none)'}`);
  const typed = [...contract.documentTypedArrays].flatMap(([type, list]) => list.map((a) => `${type}.${a.path}[${a.items.type}≤${a.maxItems}${a.items.refersTo ? `→${a.items.refersTo.type}` : ''}]`));
  console.log(`    typed arrays:     ${typed.join(', ') || '(none)'}`);
  // `documentTypeReferences` reports the reference kind consensus enforces;
  // whether each target admits it (40122/40131/40143/40144) is audited in
  // auditNodeRules.
  for (const referrer of Object.keys(source.documentSchemas)) {
    for (const reference of contract.documentTypeReferences(referrer)) {
      if (reference.path === '$ownerId') console.log(`    ownerRefersTo:    ${referrer} → ${describeReference(reference)}`);
      else if (reference.findBy || reference.where) console.log(`    refersTo:         ${referrer}.${reference.path} → ${describeReference(reference)}`);
    }
  }
  // The node-side rules neither parse runs, for the declarations Yappr uses.
  const size = createTransitionSize(contract, { DataContractCreateTransition, platformVersion });
  console.log(`    create size:      ~${size.bytes} B signed (budget ${CREATE_TRANSITION_BUDGET}, cap ${STATE_TRANSITION_CAP})`);
  const meta = metaSchemaProblems(source);
  console.log(`    meta-schema v3:   ${meta.length === 0 ? 'ok' : `${meta.length} problem(s)`}`);
  const problems = [...auditNodeRules(source, { network }), ...meta];
  // Over the cap is a refusal; between the budget and the cap is a warning.
  if (size.overCap) problems.push(`the create transition is ~${size.bytes} B signed, over the ${STATE_TRANSITION_CAP} B cap (rs-dapi refuses it, Drive 10602)`);
  else if (!size.fits && strictSize) problems.push(`the create transition is ~${size.bytes} B signed, over the ${CREATE_TRANSITION_BUDGET} B headroom budget (--strict-size)`);
  else if (!size.fits) console.log(`WARN  the create transition is ~${size.bytes} B signed, inside the cap but over the ${CREATE_TRANSITION_BUDGET} B headroom budget`);
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  if (problems.length > 0) throw new Error(`${problems.length} rule(s) the node would refuse (see above)`);
  for (const documentType of immutable) {
    // 5.0: `immutableWhen` conditions carry numeric literals as BigInt.
    console.log(`    ${documentType}: ${JSON.stringify(contract.documentTypeImmutableProperties(documentType), (_key, value) => (typeof value === 'bigint' ? value.toString() : value))}`);
  }
  return contract;
}

/**
 * `documentCreateCost` (#5159) per document type, at its defaults: every
 * optional field present and every variable one at mid-length. "new" is the
 * first document with its index values (it creates their trees); "known" is a
 * later one. Processing is an estimate, storage is exact.
 */
function printCosts(contract, source) {
  const platformVersion = PlatformVersion.latest();
  const millions = (credits) => `${(Number(credits) / 1e6).toFixed(1)}M`.padStart(8);
  console.log('\ncreate cost per type (documentCreateCost; credits, new / known index values):');
  for (const name of Object.keys(source.documentSchemas)) {
    try {
      const cost = documentCreateCost(contract, name, undefined, platformVersion);
      console.log(`    ${name.padEnd(20)} ${millions(cost.totalCredits.newValues)} / ${millions(cost.totalCredits.knownValues)}   (document ${cost.documentBytes} B)`);
    } catch (e) {
      console.log(`    ${name.padEnd(20)} (not priced: ${String(e?.message ?? e).slice(0, 100)})`);
    }
  }
  printWriteCosts(contract, source, platformVersion);
}

/** USD cents at $60/DASH: 10^11 credits are one DASH, so 1M credits = 0.06¢. */
const CENTS_PER_CREDIT = 60 * 100 / 1e11;

/**
 * The writes Yappr makes, one document shape each: [label, type, the optional
 * fields present, with a length for a variable-size one]. A field ending in
 * `?` is priced only where the cut declares it (`live` and `rootOwnerId` are
 * v13's); a write naming any other field the cut lacks is skipped. Every other
 * optional field is absent. A typed array's length is its element count; the
 * estimator prices each element at the middle of its bound (256 characters
 * for a media URL), so the media rows overstate an ipfs:// link.
 */
const SOCIAL_WRITES = [
  ['post, 140 characters', 'post', { content: 140, 'live?': 0 }],
  ['post, 140 characters, tagged', 'post', { content: 140, hashtag: 8, 'live?': 0 }],
  ['post, one image', 'post', { content: 140, 'live?': 0, mediaUrls: 1, mediaDigests: 40, mediaKinds: 1 }],
  ['post, four images', 'post', { content: 140, 'live?': 0, mediaUrls: 4, mediaDigests: 160, mediaKinds: 4 }],
  ['private post (300 B ciphertext)', 'post', { encryptedContent: 300, keyGeneration: 0, nonce: 0, 'live?': 0 }],
  ['quote', 'post', { content: 140, quotedPostId: 0, quotedPostOwnerId: 0, 'live?': 0 }],
  ['repost (a bare quote)', 'post', { quotedPostId: 0, quotedPostOwnerId: 0, 'live?': 0 }],
  ['reply, 140 characters', 'reply', { content: 140 }],
  ['reply to a reply', 'reply', { content: 140, replyToReplyId: 0 }],
  ['reply, one image', 'reply', { content: 140, mediaUrls: 1, mediaDigests: 40, mediaKinds: 1 }],
  ['like', 'like', {}],
  ['like, tagged post', 'like', { hashtag: 8 }],
  ['reply like', 'likeReply', {}],
  ['report a post', 'report', { postId: 0 }],
  ['report a reply', 'report', { replyId: 0 }],
  ['report a profile', 'report', { about: 0 }],
  ['report a private post, box for 3 moderators (400 B)', 'report', { postId: 0, box: 400 }],
  ['report a private post, a full box (5,120 B)', 'report', { postId: 0, box: 5120 }],
  ['bookmark', 'bookmark', {}],
  ['follow', 'follow', {}],
  ['block', 'block', {}],
  ['block filter (one 1 KB bloom filter)', 'blockFilter', { filterData: 1024, itemCount: 0, version: 0 }],
];

/**
 * `documentCreateCost` for each write in SOCIAL_WRITES whose type the cut has:
 * the network fee (storage plus estimated processing) for the first document
 * with its index values and for a later one, and the action fee the contract
 * adds on top. Token costs (YAPP) are not credits and are not included.
 */
function printWriteCosts(contract, source, platformVersion) {
  const rows = [];
  for (const [label, type, wanted] of SOCIAL_WRITES) {
    const schema = source.documentSchemas[type];
    if (!schema) continue;
    const declared = Object.keys(schema.properties);
    const present = Object.entries(wanted).map(([name, length]) => [name.replace(/\?$/, ''), length, name.endsWith('?')]);
    if (present.some(([name, , optional]) => !optional && !declared.includes(name))) continue;
    const fields = Object.fromEntries(declared.filter((p) => !schema.required?.includes(p)).map((p) => [p, { present: false }]));
    for (const [name, length] of present) if (declared.includes(name)) fields[name] = length > 0 ? { present: true, length } : { present: true };
    const cost = documentCreateCost(contract, type, { fields }, platformVersion);
    const actionFee = cost.contractCharges.filter((c) => c.kind === 'actionFee').reduce((n, c) => n + c.charged.owner + c.charged.moderators, 0);
    const network = (scenario) => Number(cost.totalCredits[scenario]) - actionFee;
    rows.push([label, network('newValues'), network('knownValues'), actionFee]);
  }
  if (rows.length === 0) return;
  const credits = (n) => `${(n / 1e6).toFixed(1)}M (${(n * CENTS_PER_CREDIT).toFixed(2)}¢)`;
  console.log('\nnetwork fee per write (documentCreateCost: storage + estimated processing; first with its index values / later; ¢ at $60/DASH) + the action fee:');
  for (const [label, first, later, actionFee] of rows) {
    console.log(`    ${label.padEnd(52)} ${credits(first).padStart(17)} / ${credits(later).padStart(17)}${actionFee ? `   + ${credits(actionFee)} action fee` : ''}`);
  }
}

async function main() {
  // The wasm modules back every class below; nothing works before they load.
  await Promise.all([ensureInitialized(), initWasmDpp2()]);
  const { file, immutable, probes, constraints, cost, strictSize, network, interim } = parseArgs(process.argv.slice(2));
  if (file) {
    const contract = validateFile(file, { immutable, strictSize, network, interim });
    if (cost) printCosts(contract, loadContractSource(file, { network, interim }));
  }
  if (probes) {
    const platformVersion = PlatformVersion.latest();
    const sizeOf = (contract) => createTransitionSize(contract, { DataContractCreateTransition, platformVersion });
    const failed = runContractProbes({ loadContractSource, parseContract, parseWithNodeRules, sizeOf, updateRefusals });
    if (failed > 0) throw new Error(`${failed} probe(s) did not behave as recorded`);
  }
  if (constraints) {
    const failed = await runConstraintCases({ loadContractSource, parseContract, platformVersion: PlatformVersion.latest(), Document });
    if (failed > 0) throw new Error(`${failed} propertyConstraints case(s) did not behave as recorded`);
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
