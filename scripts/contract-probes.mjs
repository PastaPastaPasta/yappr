/**
 * The registration rules the wasm DPP parse does NOT run, re-checked offline,
 * and the negative probes that record which refusals are local and which only
 * a node makes. Used by `validate-contract-offline.mjs`.
 *
 * Measured on @dashevo/wasm-sdk 4.2.0-beta.6 (first on beta.4) with `DataContract.fromJSON(json,
 * true, latest)`: the structural parser runs (lookups, distinctFrom targets,
 * contested + moderator delete, immutable deletable lookups, serde shape of
 * the moderation declaration), but the rules behind rs-dpp's `validation`
 * feature and the create transition's basic structure do not:
 *
 *   - `ContractModerationConfig::validate` (10900): election windows, the
 *     cool-down, maxAddedModerators, the moderated set and the list each
 *     ability needs. A 3600 s join window parses locally; the node refuses it.
 *   - `max_typed_array_items` (1024) and `max_references_per_document` (256).
 *   - The deletability of a reference's target (40122 permanentDocument at a
 *     deletable type, 40131 deletableDocument at a permanent one): those are
 *     judged against the whole contract at registration.
 *   - `validate_no_immutable_deletable_element_references`: a deletableDocument
 *     lookup held by an `immutable` property.
 *   - The JSON meta-schema (an unknown keyword parses).
 *
 * 4.2.0-beta.5 adds two the parse also skips (both behind the `validation`
 * feature): `immutableAllowSetting` on a deletableDocument reference (#4983)
 * and an immutable contract reference with an `owner` requirement on a
 * transferable type (#4982). The document `ttl` rules (#5007) ARE in the parse,
 * but a `ttl` also makes its type deletable for the 40122/40131 checks
 * (`documents_can_disappear`), which is registration-time.
 *
 * `auditNodeRules` re-implements the ones Yappr's cuts rely on, from the rs-dpp
 * source at v4.2.0-beta.5 (config/moderation/{mod,elected}.rs,
 * try_from_schema/v3/mod.rs, create_document_types_from_document_schemas/v1).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SystemLimits (rs-platform-version system_limits/v4.rs, protocol 14).
const LIMITS = {
  maxStateTransitionSize: 20_480,
  // The one-day floor is mainnet's; from 4.2.0-beta.6 (#5108) any other network
  // takes 0 (elected.rs `window_min`). The ceiling holds everywhere.
  electionWindow: [0, 2_419_200],
  mainnetElectionWindowFloor: 86_400,
  challengeCoolDown: [1_209_600, 94_608_000],
  maxAddedModerators: 15,
  maxModerators: 16,
  maxTypedArrayItems: 1024,
  maxReferencesPerDocument: 256,
};

/**
 * Budget for a contract create: the unsigned DataContractCreateTransition
 * bytes plus a signature and key id (~70 B for ECDSA; 100 B allowed), kept
 * under 20,000 so a later edit does not land on the 20,480-byte cap
 * (rs-dapi refuses a larger broadcast; Drive decodes it as 10602).
 */
export const CREATE_TRANSITION_BUDGET = 20_000;
const STATE_TRANSITION_CAP = LIMITS.maxStateTransitionSize;
export const SIGNATURE_ALLOWANCE = 100;

// ---- JSON meta-schema --------------------------------------------------------

/**
 * rs-dpp's document meta-schema v3 at v4.2.0-beta.6 (beta.5 added `ttl` and
 * the anyOf/allOf/not/in/present/absent/const propertyConstraints grammar;
 * beta.6 added `generatedFrom`, ifThen/ifThenElse/notIn/min/max/abs,
 * contains/startsWith/endsWith, length/byteLength/count, system times,
 * identifier and string comparisons, and countOf/sumOf), vendored byte for byte
 * (`packages/rs-dpp/schema/meta_schemas/document/v3/document-meta.json`) and
 * pinned by hash. The wasm parse does not run it, so a keyword typo or a
 * keyword in the wrong place parses locally and is refused by the node.
 */
const META_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'meta-schema', 'document-meta-v3.json');
const META_SCHEMA_SHA256 = '88083a21d9c428c87d05cbf29f6814e674df9e596b63bc960057892c7664589f';

let metaValidator;
/**
 * A compiled validator for one document schema, or null when ajv is not
 * installed (it is a transitive dependency only; nothing here adds it to
 * package.json). rs-dpp validates each doctype enriched with `$schema` and the
 * contract's `$defs` (enrich_with_base_schema_v0).
 */
function metaSchemaValidator() {
  if (metaValidator !== undefined) return metaValidator;
  const text = readFileSync(META_SCHEMA_PATH);
  const digest = createHash('sha256').update(text).digest('hex');
  if (digest !== META_SCHEMA_SHA256) throw new Error(`${META_SCHEMA_PATH} is not the pinned v4.2.0-beta.6 meta-schema (sha256 ${digest})`);
  try {
    const require = createRequire(import.meta.url);
    const Ajv2020 = require('ajv/dist/2020').default;
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const meta = JSON.parse(text);
    const validate = ajv.compile(meta);
    metaValidator = { validate, id: meta.$id };
  } catch (e) {
    console.log(`    meta-schema:      SKIPPED (ajv unavailable: ${String(e?.message ?? e).slice(0, 80)})`);
    metaValidator = null;
  }
  return metaValidator;
}

/** Meta-schema problems per doctype; [] when every doctype validates (or ajv is absent). */
export function metaSchemaProblems(source) {
  const meta = metaSchemaValidator();
  if (!meta) return [];
  const problems = [];
  for (const [name, schema] of Object.entries(source.documentSchemas)) {
    const enriched = { $schema: meta.id, ...schema, ...(source.$defs ? { $defs: source.$defs } : {}) };
    if (!meta.validate(enriched)) {
      const first = meta.validate.errors?.[0];
      problems.push(`${name}: meta-schema ${first?.instancePath || '/'} ${first?.message ?? 'invalid'} (${first?.schemaPath ?? ''})`);
    }
  }
  return problems;
}

/** Signed-size estimate of the create transition, and whether it fits the budget. */
export function createTransitionSize(contract, { DataContractCreateTransition, platformVersion }) {
  const bytes = new DataContractCreateTransition(contract, 1n, platformVersion).toBytes().length + SIGNATURE_ALLOWANCE;
  return { bytes, fits: bytes <= CREATE_TRANSITION_BUDGET, overCap: bytes > STATE_TRANSITION_CAP };
}
const ABILITY_LIST = { ban: 'banlist', suspend: 'suspensions', warn: 'warnings' };
const INTERIM_KINDS = ['contractOwner', 'appointedModerators', 'notYetUsable', 'noModeration'];

const within = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;

/**
 * Can a document of `schema` disappear — deleted by its owner, a moderator, or
 * (4.2.0-beta.5, #5007) the platform once its `ttl` passes? rs-dpp
 * `documents_can_disappear`.
 */
function deletable(schema, config) {
  const ownerMay = schema.canBeDeleted ?? config.documentsCanBeDeletedContractDefault ?? true;
  return ownerMay === true || schema.canBeDeletedByModerators === true || schema.ttl !== undefined;
}

/** Can a document of `schema` change owner (transfer or trade)? rs-dpp `owner_can_change`. */
function ownerCanChange(schema) {
  return (schema.transferable ?? 0) !== 0 || (schema.tradeMode ?? 0) !== 0;
}

/**
 * Every reference declaration of a doctype: [path, refersTo, inExpression]
 * (leaves of anyOf/allOf included; `inExpression` marks such a leaf). Paths are
 * dotted through object properties (`meta.storeId`), as rs-dpp's
 * `flattened_properties` walks them; a typed array's items end in `[]`.
 */
function referenceDeclarations(schema) {
  const out = [];
  const leaves = (path, ref, inExpression = false) => {
    for (const key of ['anyOf', 'allOf']) if (Array.isArray(ref[key])) { for (const leaf of ref[key]) leaves(path, leaf, true); return; }
    out.push([path, ref, inExpression]);
  };
  const walk = (properties, prefix) => {
    for (const [name, definition] of Object.entries(properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (definition.refersTo) leaves(path, definition.refersTo);
      if (definition.items?.refersTo) leaves(`${path}[]`, definition.items.refersTo);
      if (definition.type === 'object' && definition.properties) walk(definition.properties, path);
    }
  };
  if (schema.ownerRefersTo) leaves('$ownerId', schema.ownerRefersTo);
  walk(schema.properties, '');
  return out;
}

/** References one document can carry, the way rs-dpp's validate_reference_count counts them. */
function referenceBudget(schema) {
  const leafCount = (ref) => (ref.anyOf ?? ref.allOf ?? [ref]).reduce((n, leaf) => n + (leaf.anyOf || leaf.allOf ? leafCount(leaf) : 1), 0);
  let total = schema.ownerRefersTo ? leafCount(schema.ownerRefersTo) : 0;
  for (const definition of Object.values(schema.properties ?? {})) {
    if (definition.refersTo) total += leafCount(definition.refersTo);
    if (definition.items?.refersTo) total += definition.maxItems * leafCount(definition.items.refersTo);
  }
  return total;
}

function auditElected(elected, moderation, schemas, { network }) {
  const problems = [];
  const bounds = network === 'mainnet' ? [LIMITS.mainnetElectionWindowFloor, LIMITS.electionWindow[1]] : LIMITS.electionWindow;
  for (const key of ['joinWindow', 'voteWindow']) {
    const value = elected[key] ?? 604_800;
    if (!within(value, bounds)) problems.push(`elected ${key} ${value} s is outside ${bounds.join(' to ')} s on ${network} (10900)`);
  }
  if (typeof elected.seatContestable !== 'boolean') problems.push('elected seatContestable is required');
  if (elected.seatContestable === true && !within(elected.challengeCoolDown, LIMITS.challengeCoolDown)) {
    problems.push(`a contestable seat needs a challengeCoolDown within ${LIMITS.challengeCoolDown.join(' to ')} s`);
  }
  if (elected.seatContestable === false && elected.challengeCoolDown !== undefined) problems.push('a seat that cannot be contested declares no challengeCoolDown');
  if ((elected.maxAddedModerators ?? 0) > LIMITS.maxAddedModerators) problems.push(`maxAddedModerators ${elected.maxAddedModerators} exceeds ${LIMITS.maxAddedModerators} (10900)`);
  const moderated = Object.entries(elected.moderatedDocumentTypes ?? {});
  if (moderated.length === 0) problems.push('the elected moderated document type set is empty (10900)');
  for (const [docType, abilities] of moderated) {
    if (!schemas[docType]) { problems.push(`moderated document type "${docType}" is not a document type of the contract (10900)`); continue; }
    if (!Array.isArray(abilities) || abilities.length === 0) problems.push(`"${docType}" has an empty ability set (10900)`);
    for (const ability of abilities ?? []) {
      if (ability === 'deleteDocuments') {
        if (schemas[docType].canBeDeletedByModerators !== true) problems.push(`"${docType}" allows deleteDocuments but is not canBeDeletedByModerators (10900)`);
      } else if (ABILITY_LIST[ability]) {
        if (moderation[ABILITY_LIST[ability]] !== true) problems.push(`"${docType}" allows ${ability} but the contract keeps no ${ABILITY_LIST[ability]} list (10900)`);
      } else {
        problems.push(`"${docType}" names an unknown ability "${ability}"`);
      }
    }
  }
  const interim = elected.interim?.$type;
  if (!INTERIM_KINDS.includes(interim)) problems.push(`interim $type "${interim}" is not one of ${INTERIM_KINDS.join(', ')}`);
  if (interim === 'appointedModerators') {
    const ids = elected.interim.identities ?? [];
    if (ids.length === 0 || ids.length > LIMITS.maxModerators) problems.push(`the interim set names ${ids.length} identities; 1 to ${LIMITS.maxModerators} allowed (10900)`);
  }
  return problems;
}

/**
 * The node-side registration rules Yappr's cuts depend on and the wasm parse
 * skips. Returns a list of problems (empty = the node would accept on these
 * counts). `network` picks the election-window floor: one day on mainnet,
 * 0 elsewhere (#5108). Yappr's cuts register on moutai, so devnet is the default.
 */
export function auditNodeRules(source, { network = 'devnet' } = {}) {
  const problems = [];
  const schemas = source.documentSchemas;
  const config = source.config ?? {};
  const moderation = config.moderation;

  if (moderation) {
    if (config.$formatVersion !== '2') problems.push('config.moderation needs config.$formatVersion "2" (a "1" config drops it)');
    const anyList = moderation.banlist || moderation.suspensions || moderation.warnings;
    const anyDeletable = Object.values(schemas).some((s) => s.canBeDeletedByModerators === true);
    if (!anyList && !anyDeletable) problems.push('moderation keeps no list and no type is moderator-deletable (10900)');
    const moderators = moderation.moderators ?? {};
    if (moderators.$type === 'appointedModerators') {
      const ids = moderators.identities ?? [];
      if (ids.length === 0 || ids.length > LIMITS.maxModerators) problems.push(`${ids.length} appointed moderators; 1 to ${LIMITS.maxModerators} allowed (10900)`);
    } else if (moderators.$type === 'elected') {
      problems.push(...auditElected(moderators, moderation, schemas, { network }));
    }
  }

  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.canBeDeletedByModerators && (schema.indices ?? []).some((index) => index.contested)) {
      problems.push(`${name}: canBeDeletedByModerators on a type with a contested index`);
    }
    for (const [path, definition] of Object.entries(schema.properties ?? {})) {
      if (definition.items && definition.maxItems > LIMITS.maxTypedArrayItems) {
        problems.push(`${name}.${path}: typed array maxItems ${definition.maxItems} exceeds ${LIMITS.maxTypedArrayItems}`);
      }
    }
    const budget = referenceBudget(schema);
    if (budget > LIMITS.maxReferencesPerDocument) problems.push(`${name}: up to ${budget} references per document, above ${LIMITS.maxReferencesPerDocument}`);
    // #4983 (beta.5): a single deletableDocument reference by id, declared as the
    // whole refersTo (not inside anyOf/allOf, not a lookup), may be cleared once its
    // target is gone, so it may not also be settable while absent. rs-dpp matches the
    // whole target, not its leaves (validate_no_immutable_deletable_element_references).
    for (const path of schema.immutableAllowSetting ?? []) {
      const ref = schema.properties?.[path]?.refersTo;
      if (ref?.type === 'deletableDocument' && !ref.lookup) {
        problems.push(`${name}.${path}: immutableAllowSetting on a deletableDocument reference (#4983)`);
      }
    }
    for (const [path, ref, inExpression] of referenceDeclarations(schema)) {
      // validate_no_immutable_deletable_element_references: a deletable lookup, a
      // typed array of deletable refs, or a by-id deletable ref inside an object,
      // held under an `immutable` top-level property, could never be re-validated
      // once its target is gone, so the type could never be replaced.
      const topLevel = path.split('.')[0].replace(/\[\]$/, '');
      const heldImmutably = (schema.immutable ?? []).includes(topLevel);
      const isList = path.endsWith('[]');
      const nested = path.replace(/\[\]$/, '') !== topLevel;
      if (heldImmutably && ref.type === 'deletableDocument' && (ref.lookup || isList || (nested && !inExpression))) {
        const heldAs = ref.lookup ? 'lookup' : isList ? 'typed array' : 'reference inside an object';
        problems.push(`${name}.${path}: a deletableDocument ${heldAs} under \`immutable\``);
      }
      // #4982 (beta.5): an immutable contract reference with an owner requirement on a
      // type whose documents can change owner could never be replaced by the new owner.
      // rs-dpp reads `owner` as present only when it names a relation (a JSON null is none).
      const ownerRequirement = ref.contractRequirements?.owner;
      if (heldImmutably && ref.type === 'contract' && ownerRequirement !== undefined && ownerRequirement !== null && ownerCanChange(schema)) {
        problems.push(`${name}.${path}: immutable contract reference with an owner requirement on a transferable type (#4982)`);
      }
      if (ref.contractId || !ref.documentType || !['permanentDocument', 'deletableDocument'].includes(ref.type)) continue;
      const target = schemas[ref.documentType];
      if (!target) { problems.push(`${name}.${path}: refersTo unknown document type "${ref.documentType}"`); continue; }
      const targetDeletable = deletable(target, config);
      if (ref.type === 'permanentDocument' && targetDeletable) problems.push(`${name}.${path}: permanentDocument at deletable "${ref.documentType}" (40122)`);
      if (ref.type === 'deletableDocument' && !targetDeletable) problems.push(`${name}.${path}: deletableDocument at permanent "${ref.documentType}" (40131)`);
    }
  }
  return problems;
}

// ---- Negative probes ---------------------------------------------------------

const SOCIAL_V9 = 'contracts/yappr-social-contract-v9.json';
const STOREFRONT = 'contracts/yappr-storefront-contract.json';
const PROFILE = 'contracts/yappr-profile-contract.json';

const elected = (source) => source.config.moderation.moderators;

/**
 * Each probe mutates a committed cut and records where it is refused:
 * `wasm` = by the local full-validation parse, `audit` = by `auditNodeRules`
 * only (the node refuses it; the SDK does not check it before signing), or
 * `accepted` for a control that must pass both.
 */
const PROBES = [
  { label: 'control: social v9 as committed', file: SOCIAL_V9, mutate: () => {}, expect: 'accepted' },
  { label: 'control: storefront as committed', file: STOREFRONT, mutate: () => {}, expect: 'accepted' },
  { label: 'control: profile as committed', file: PROFILE, mutate: () => {}, expect: 'accepted' },

  // Elected declaration (config/moderation/elected.rs). The windows are
  // basic-structure rules of the create transition: the node refuses 10900.
  // Since 4.2.0-beta.6 (#5108) the one-day floor is mainnet's only: v9 as cut
  // declares 3600 s windows for moutai, and a window of 0 is legal off mainnet.
  { label: 'elected windows of 0 s off mainnet (control)', file: SOCIAL_V9, expect: 'accepted', mutate: (s) => { elected(s).joinWindow = 0; elected(s).voteWindow = 0; } },
  { label: 'elected joinWindow of 3600 s on mainnet', file: SOCIAL_V9, network: 'mainnet', expect: 'audit', node: '10900', mutate: () => {} },
  { label: 'elected voteWindow over four weeks', file: SOCIAL_V9, expect: 'audit', node: '10900', mutate: (s) => { elected(s).voteWindow = 2_419_201; } },
  { label: 'elected maxAddedModerators 16', file: SOCIAL_V9, expect: 'audit', node: '10900', mutate: (s) => { elected(s).maxAddedModerators = 16; } },
  { label: 'elected warn ability without a warning list', file: SOCIAL_V9, expect: 'audit', node: '10900', mutate: (s) => { s.config.moderation.warnings = false; } },
  { label: 'elected deleteDocuments on a type moderators cannot delete', file: SOCIAL_V9, expect: 'audit', node: '10900', mutate: (s) => { elected(s).moderatedDocumentTypes.follow = ['deleteDocuments']; } },
  { label: 'elected moderated type the contract does not have', file: SOCIAL_V9, expect: 'audit', node: '10900', mutate: (s) => { elected(s).moderatedDocumentTypes.nope = ['ban']; } },
  { label: 'elected seat contestable without challengeCoolDown', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { elected(s).seatContestable = true; } },
  { label: 'elected declaration without seatContestable', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { delete elected(s).seatContestable; } },
  { label: 'elected unknown ability', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { elected(s).moderatedDocumentTypes.post = ['nuke']; } },
  { label: 'config $formatVersion "1" drops moderation (post then cannot be moderator-deletable)', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { s.config.$formatVersion = '1'; } },

  // distinctFrom (#4917).
  { label: 'distinctFrom naming a property the type does not have', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { s.documentSchemas.follow.properties.followingId.distinctFrom = 'nope'; } },
  { label: 'distinctFrom naming itself', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { s.documentSchemas.follow.properties.followingId.distinctFrom = 'followingId'; } },
  { label: 'distinctFrom on a string property', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { s.documentSchemas.block.properties.message.distinctFrom = '$ownerId'; } },
  { label: 'distinctFrom on a typed array instead of its items', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { const p = s.documentSchemas.blockFollow.properties.followedBlockers; delete p.items.distinctFrom; p.distinctFrom = '$ownerId'; } },

  // canBeDeletedByModerators is refused on a type with a contested index.
  { label: 'canBeDeletedByModerators on a type with a contested index', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => {
    s.documentSchemas.post.indices.push({ name: 'contestedProbe', unique: true, properties: [{ language: 'asc' }], contested: { resolution: 0, fieldMatches: [{ field: 'language', regexPattern: '^[a-z]{2}$' }], description: 'probe' } });
  } },

  // Private-feed gates (#4930 #4941).
  { label: 'grant lookup into followRequest whose targetId is not immutable', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { delete s.documentSchemas.followRequest.immutable; } },
  { label: 'an immutable list holding the deletable followRequest lookup', file: SOCIAL_V9, expect: 'audit', node: 'registration', mutate: (s) => { const g = s.documentSchemas.privateFeedGrant; g.documentsMutable = true; g.immutable = ['recipientId']; } },
  { label: 'permanentDocument owner gate at a deletable privateFeedState', file: SOCIAL_V9, expect: 'audit', node: '40122', mutate: (s) => { s.documentSchemas.privateFeedState.canBeDeleted = true; } },

  // Typed arrays (#4922 #4923 #4928 #4924).
  { label: 'blockFollow typed array of 300 identity references (budget 256)', file: SOCIAL_V9, expect: 'audit', node: 'registration', mutate: (s) => { s.documentSchemas.blockFollow.properties.followedBlockers.maxItems = 300; } },
  { label: 'typed array maxItems 1025', file: PROFILE, expect: 'audit', node: 'registration', mutate: (s) => { s.documentSchemas.profile.properties.paymentUris.maxItems = 1025; } },
  { label: 'typed array without maxItems', file: PROFILE, expect: 'wasm', mutate: (s) => { delete s.documentSchemas.profile.properties.paymentUris.maxItems; } },
  { label: 'typed string items with maxBytes below minLength', file: PROFILE, expect: 'wasm', mutate: (s) => { s.documentSchemas.profile.properties.socialLinks.items.maxBytes = 2; } },
  { label: 'an unknown keyword on a property (meta-schema)', file: SOCIAL_V9, expect: 'audit', node: '10101', mutate: (s) => { s.documentSchemas.follow.properties.followingId.distinctFromm = '$ownerId'; } },
  { label: 'v8 plus every property description back (over the 20480-byte transition cap)', file: SOCIAL_V9, expect: 'audit', node: '10602 / rs-dapi size refusal', mutate: (s) => {
    for (const schema of Object.values(s.documentSchemas)) for (const d of Object.values(schema.properties)) d.description = 'x'.repeat(60);
  } },
  { label: 'storefront distinctFrom on a byte array that is not an identifier', file: STOREFRONT, expect: 'wasm', mutate: (s) => { s.documentSchemas.storeOrder.properties.nonce.distinctFrom = '$ownerId'; } },

  // 4.2.0-beta.5 registration refusals (docs/PLATFORM_BETA5_UPGRADE.md).
  { label: 'immutableAllowSetting on a deletableDocument reference (#4983)', file: SOCIAL_V9, expect: 'audit', node: 'registration', mutate: (s) => { s.documentSchemas.post.immutableAllowSetting.push('quotedPostId'); } },
  // A by-id deletableDocument cannot be an expression leaf at all (the parse refuses
  // it), so #4983 only ever concerns a whole-target reference, which is what the audit reads.
  { label: 'a by-id deletableDocument inside anyOf (refused by the parse, not #4983)', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => {
    const p = s.documentSchemas.post;
    p.properties.quotedPostId.refersTo = { anyOf: [{ type: 'deletableDocument', documentType: 'post' }, { type: 'identity' }] };
    p.immutableAllowSetting.push('quotedPostId');
  } },
  // Document TTL (#5007): the parse refuses the structural pairings and the
  // one-hour floor; the deletability a ttl gives its type (40122) is judged at registration.
  { label: 'ttl of one day on savedAddress (control)', file: STOREFRONT, expect: 'accepted', mutate: (s) => { s.documentSchemas.savedAddress.ttl = 86_400; } },
  { label: 'ttl on a type without $createdAt in required', file: STOREFRONT, expect: 'wasm', mutate: (s) => { const t = s.documentSchemas.savedAddress; t.ttl = 86_400; t.required = t.required.filter((p) => p !== '$createdAt'); } },
  { label: 'ttl on an indexOnly type', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { s.documentSchemas.like.ttl = 86_400; } },
  { label: 'ttl of 0', file: STOREFRONT, expect: 'wasm', mutate: (s) => { s.documentSchemas.savedAddress.ttl = 0; } },
  { label: 'ttl of 60 s (under the one-hour floor)', file: STOREFRONT, expect: 'wasm', mutate: (s) => { s.documentSchemas.savedAddress.ttl = 60; } },
  { label: 'ttl with documentsKeepHistory', file: STOREFRONT, expect: 'wasm', mutate: (s) => { const t = s.documentSchemas.savedAddress; t.ttl = 86_400; t.documentsKeepHistory = true; } },
  { label: 'ttl on the target of a permanentDocument owner gate (privateFeedState)', file: SOCIAL_V9, expect: 'audit', node: '40122', mutate: (s) => { s.documentSchemas.privateFeedState.ttl = 86_400; } },
  // beta.6 v9: report carries a 90-day ttl (the one-hour floor and a one-year ceiling).
  { label: 'report ttl without $createdAt in required', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { const t = s.documentSchemas.report; t.required = t.required.filter((p) => p !== '$createdAt'); } },
  { label: 'report ttl over one year', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { s.documentSchemas.report.ttl = 31_536_001; } },
  { label: 'immutable contract reference with an owner requirement on a transferable type (#4982)', file: STOREFRONT, expect: 'audit', node: 'registration', mutate: (s) => {
    const t = s.documentSchemas.savedAddress;
    t.transferable = 1; t.documentsMutable = true; t.immutable = ['appContractId'];
    t.properties.appContractId = { type: 'array', byteArray: true, minItems: 32, maxItems: 32, contentMediaType: 'application/x.dash.dpp.identifier', position: 99, refersTo: { type: 'contract', contractRequirements: { owner: 'self' } } };
  } },
  { label: 'immutable object holding a by-id deletableDocument reference (nested path)', file: STOREFRONT, expect: 'audit', node: 'registration', mutate: (s) => {
    const t = s.documentSchemas.savedAddress;
    t.documentsMutable = true; t.immutable = ['link'];
    t.properties.link = { type: 'object', position: 98, additionalProperties: false, properties: { storeId: { type: 'array', byteArray: true, minItems: 32, maxItems: 32, contentMediaType: 'application/x.dash.dpp.identifier', position: 0, refersTo: { type: 'deletableDocument', documentType: 'shippingZone' } } } };
  } },
  { label: 'immutable object holding a contract reference with an owner requirement on a transferable type (#4982, nested path)', file: STOREFRONT, expect: 'audit', node: 'registration', mutate: (s) => {
    const t = s.documentSchemas.savedAddress;
    t.transferable = 1; t.documentsMutable = true; t.immutable = ['app'];
    t.properties.app = { type: 'object', position: 97, additionalProperties: false, properties: { contractId: { type: 'array', byteArray: true, minItems: 32, maxItems: 32, contentMediaType: 'application/x.dash.dpp.identifier', position: 0, refersTo: { type: 'contract', contractRequirements: { owner: 'other' } } } } };
  } },
  // propertyConstraints grammar (#5036-#5042).
  { label: 'propertyConstraints enum const + absent (control)', file: STOREFRONT, expect: 'accepted', mutate: (s) => { s.documentSchemas.storeItem.propertyConstraints = { soldOutHasNoStock: { anyOf: [{ notEqual: ['status', { const: 'sold_out' }] }, { absent: 'stockQuantity' }, { equal: ['stockQuantity', 0] }] } }; } },
  { label: 'propertyConstraints const outside the enum', file: STOREFRONT, expect: 'wasm', mutate: (s) => { s.documentSchemas.storeItem.propertyConstraints = { r: { equal: ['status', { const: 'gone' }] } }; } },
  { label: 'propertyConstraints anyOf directly inside anyOf', file: STOREFRONT, expect: 'wasm', mutate: (s) => { s.documentSchemas.storeItem.propertyConstraints = { r: { anyOf: [{ anyOf: [{ equal: ['weight', 0] }, { equal: ['weight', 1] }] }, { equal: ['weight', 2] }] } }; } },
  // The rules the beta.5 cuts declare (property-constraint-cases.mjs): each
  // leans on a parse rule a slip would trip, and on the node-only limits.
  { label: 'tombstoneIsBlank reading a property post does not have', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { s.documentSchemas.post.propertyConstraints.tombstoneIsBlank.ifThen[1].allOf[1] = { absent: 'mediaUrls' }; } },
  { label: 'tieredHasTiers comparing rateType with a value outside its enum', file: STOREFRONT, expect: 'wasm', mutate: (s) => { s.documentSchemas.shippingZone.propertyConstraints.tieredHasTiers.anyOf[0] = { equal: ['rateType', { const: 'flat_rate' }] }; } },
  { label: 'privateAllOrNone reading a string property as an integer operand', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => { s.documentSchemas.post.propertyConstraints.privateAllOrNone = { greaterThan: ['language', 0] }; } },
  { label: 'a 17th propertyConstraints rule on post (16 max)', file: SOCIAL_V9, expect: 'wasm', mutate: (s) => {
    for (let n = 0; n < 11; n++) s.documentSchemas.post.propertyConstraints[`extra${n}`] = { absent: `content` };
  } },
  // rs-dpp node_count: allOf 1 + each `anyOf [absent, present]` 3; 22 as cut, so 4 more make 34.
  { label: 'a 34-node optionsContiguous rule (32 max)', file: 'contracts/pollr-contract.json', expect: 'wasm', mutate: (s) => {
    const rule = s.documentSchemas.poll.propertyConstraints.optionsContiguous.allOf;
    for (const property of ['question', 'option0', 'option1', 'multiChoice']) rule.push({ anyOf: [{ absent: 'endsAt' }, { present: property }] });
  } },
];

/** Runs every probe; returns the number whose outcome differs from the recorded one. */
export function runContractProbes({ loadContractSource, parseContract, sizeOf }) {
  let failures = 0;
  console.log('\nnegative probes (wasm = refused by the local parse; audit = parses locally, refused by the node):');
  for (const probe of PROBES) {
    const source = structuredClone(loadContractSource(probe.file));
    probe.mutate(source);
    let wasmError = null;
    try {
      parseContract(source);
    } catch (e) {
      wasmError = String(e?.message ?? e);
    }
    const audit = [];
    if (!wasmError) {
      audit.push(...auditNodeRules(source, { network: probe.network ?? 'devnet' }), ...metaSchemaProblems(source));
      const size = sizeOf(parseContract(source));
      if (size.overCap) audit.push(`create transition ~${size.bytes} B, over the 20480 B cap`);
    }
    const outcome = wasmError ? 'wasm' : audit.length > 0 ? 'audit' : 'accepted';
    const ok = outcome === probe.expect;
    if (!ok) failures += 1;
    const detail = wasmError ?? audit[0] ?? '';
    const where = outcome === 'audit' ? ` (node: ${probe.node ?? '?'}; the SDK signs it)` : '';
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${outcome.padEnd(8)}] ${probe.label}${where}${detail ? ` — ${detail.slice(0, 150)}` : ''}${ok ? '' : ` (expected ${probe.expect})`}`);
  }
  return failures;
}
