/**
 * The registration rules the local parses do NOT run, re-checked offline,
 * and the negative probes that record which refusals are local and which only
 * a node makes. Used by `validate-contract-offline.mjs`.
 *
 * Three layers, measured on 4.2.0-beta.7 and re-run on 5.0.0-beta.1 and
 * 5.0.0-beta.2 with `DataContract.fromJSON(json, true, latest)` (and a fourth
 * for contract updates, below):
 *
 *   - **wasm-sdk** (`@dashevo/evo-sdk`): the structural parser (findBy/where,
 *     distinctFrom targets, moderatorAbilities, skipIfAbsent, ttl, …). It is
 *     built WITHOUT rs-dpp's `validation` feature, so it skips the JSON
 *     meta-schema and the index shape checks, and it silently DROPS a doctype
 *     key the meta-schema refuses: `canBeDeletedByModerators`, removed in
 *     beta.7, parses there and would be refused at registration (10101).
 *   - **wasm-dpp2** (`@dashevo/wasm-dpp2`, a devDependency): the same parser
 *     WITH `validation`, so the meta-schema and `validate_index_properties`
 *     (an index on a missing property, on `$id`, on a typed array, over a
 *     string longer than 63 characters; more than 10 indexes), the typed-array
 *     ceiling and the reference budget.
 *   - **auditNodeRules** (below): what neither parse runs, because the create
 *     transition's basic-structure validation and the registration-time
 *     reference checks run them on the node: `ContractModerationConfig::validate`
 *     (10900: election windows, the moderated set and the abilities each list
 *     or type backs), the one reference kind a target admits (40122/40131,
 *     and from 5.0.0-beta.1 40143/40144: both parses accept a
 *     `deletableDocument` reference at a moderated type, only the node refuses it),
 *     the immutable-deletable-reference rules, and the 20,480-byte transition
 *     cap, and that both sides of every same-contract `where` entry exist
 *     (40126). It also re-checks the index shapes wasm-dpp2 checks
 *     (`auditIndexShapes`, ported from the v10 study's index-audit.py), so the
 *     rules Yappr relies on do not depend on one package alone.
 *   - **update** (an `update` probe): version 2 of a committed cut parses
 *     under both, and wasm-dpp2's `DataContract.validateUpdate` (the code a
 *     data contract update transition runs, no state read) refuses it.
 *
 * The 5.0.0-beta.2 keywords (`summableOffCountIndex`, `retractedWhen`,
 * `deleteSettled.approversPredateDocument`) are all refused by the wasm-sdk
 * parse itself (10231): the structural rules run with full validation there.
 *
 * The rs-dpp sources are at v4.2.0-beta.7: config/moderation/{mod,elected}.rs,
 * try_from_schema/common/mod.rs (validate_index_properties,
 * check_indexable_property_shape), system_limits/v4.rs; and at v5.0.0-beta.1
 * for the reference kinds (document_type/v2/accessors.rs
 * `document_reference_kind`) and conditional `immutable` entries.
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
/** The state transition cap every broadcast must fit (rs-dapi refuses a larger one; Drive decodes it as 10602). */
export const STATE_TRANSITION_CAP = LIMITS.maxStateTransitionSize;
const SIGNATURE_ALLOWANCE = 100;

// ---- JSON meta-schema --------------------------------------------------------

/**
 * rs-dpp's document meta-schema v3 at v5.0.0-beta.2 (beta.2 added
 * `summableOffCountIndex` with the `{ "at": ... }` form of `rankedSummable` /
 * `rankedAverageable`, `retractedWhen` and `deleteSettled.approversPredateDocument`;
 * 5.0.0-beta.1 added conditional
 * `immutable` entries in place of the refused `immutableAllowSetting`, the
 * `moderatedDocument` reference kind, derived index properties,
 * `outlivesDelete`, `deleteKeepsFields` and `deleteSettled`; beta.7 replaced
 * `canBeDeletedByModerators`/`...For` with `moderatorAbilities`,
 * `propertyAgreement`/`lookup`/`listElement` with `where`/`findBy`/`inList`,
 * and let `skipIfAbsent` sit on any index; earlier betas added `ttl`,
 * `generatedFrom` and the propertyConstraints grammar), vendored byte for byte
 * (`packages/rs-dpp/schema/meta_schemas/document/v3/document-meta.json`) and
 * pinned by hash. The wasm-sdk parse does not run it; wasm-dpp2 does, and this
 * ajv pass names the failing path more precisely.
 */
const META_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'meta-schema', 'document-meta-v3.json');
const META_SCHEMA_SHA256 = 'e32abaed5811374727d6e3404eec2d2871e905b81c45a033b702e2f37be2dbf9';

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
  if (digest !== META_SCHEMA_SHA256) throw new Error(`${META_SCHEMA_PATH} is not the pinned v5.0.0-beta.2 meta-schema (sha256 ${digest})`);
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
export const INTERIM_KINDS = ['contractOwner', 'appointedModerators', 'notYetUsable', 'noModeration'];

const within = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;

/** `moderatorAbilities.delete: true` (rs-dpp `document_schema_lets_moderators_delete`). */
export const moderatorsMayDelete = (schema) => schema.moderatorAbilities?.delete === true;
/** A non-empty `moderatorAbilities.changeFields` (rs-dpp `document_schema_lets_moderators_change_fields`). */
const moderatorsMayChangeFields = (schema) => (schema.moderatorAbilities?.changeFields?.length ?? 0) > 0;

/**
 * Can a document of `schema` disappear — deleted by its owner, a moderator, or
 * the platform once its `ttl` passes? rs-dpp `documents_can_disappear`.
 */
function deletable(schema, config) {
  const ownerMay = schema.canBeDeleted ?? config.documentsCanBeDeletedContractDefault ?? true;
  return ownerMay === true || moderatorsMayDelete(schema) || schema.ttl !== undefined;
}

/**
 * The one document reference kind a type admits (5.0.0-beta.1, rs-dpp
 * `document_reference_kind`): permanent (nothing removes its documents),
 * moderated (only a moderator's recorded removal: canBeDeleted false, no ttl,
 * moderatorAbilities.delete keeping records), deletable (anything else).
 */
function referenceKind(schema, config) {
  if (!deletable(schema, config)) return 'permanentDocument';
  const ownerMay = schema.canBeDeleted ?? config.documentsCanBeDeletedContractDefault ?? true;
  if (ownerMay !== true && schema.ttl === undefined && moderatorsMayDelete(schema) && schema.moderatorAbilities.deleteKeepsRecord !== false) return 'moderatedDocument';
  return 'deletableDocument';
}

const DOCUMENT_REFERENCE_KINDS = ['permanentDocument', 'deletableDocument', 'moderatedDocument'];

/**
 * Null when a same-contract reference of kind `type` may point at a document
 * type declared as `target`, else why registration refuses it: 40122 (a
 * permanent reference at a type whose documents can disappear), 40131 (a
 * deletable reference at a permanent type), 40143 (a moderated reference at a
 * type that is not moderated-kind), 40144 (a deletable reference at a
 * moderated-kind type). Identity, contract and other non-document targets are
 * not judged here.
 */
export function referenceKindMismatch(type, target, config = {}) {
  if (!DOCUMENT_REFERENCE_KINDS.includes(type)) return null;
  const kind = referenceKind(target, config);
  if (type === kind) return null;
  const code = type === 'permanentDocument' ? '40122' : type === 'moderatedDocument' ? '40143' : kind === 'moderatedDocument' ? '40144' : '40131';
  return `admits only ${kind}, not ${type} (${code})`;
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
  const moderated = elected.moderatedDocumentTypes ?? {};
  if (Object.keys(moderated).length === 0) problems.push('the elected moderated document type set is empty (10900)');
  for (const [docType, abilities] of Object.entries(moderated)) {
    const schema = schemas[docType];
    if (!schema) { problems.push(`moderated document type "${docType}" is not a document type of the contract (10900)`); continue; }
    if (!Array.isArray(abilities) || abilities.length === 0) problems.push(`"${docType}" has an empty ability set (10900)`);
    for (const ability of abilities ?? []) {
      if (ability === 'deleteDocuments') {
        if (!moderatorsMayDelete(schema)) problems.push(`"${docType}" allows deleteDocuments but its moderatorAbilities has no delete (10900)`);
      } else if (ability === 'changeDocumentFields') {
        if (!moderatorsMayChangeFields(schema)) problems.push(`"${docType}" allows changeDocumentFields but lists no moderatorAbilities.changeFields (10900)`);
      } else if (ABILITY_LIST[ability]) {
        if (moderation[ABILITY_LIST[ability]] !== true) problems.push(`"${docType}" allows ${ability} but the contract keeps no ${ABILITY_LIST[ability]} list (10900)`);
      } else {
        problems.push(`"${docType}" names an unknown ability "${ability}"`);
      }
    }
  }
  // #5158: a type whose fields only moderators write must give a seated team
  // the ability, or nobody could write them once a team is seated.
  for (const [docType, schema] of Object.entries(schemas)) {
    if (moderatorsMayChangeFields(schema) && !(moderated[docType] ?? []).includes('changeDocumentFields')) {
      problems.push(`"${docType}" lists moderatorAbilities.changeFields but the moderated set does not give the team changeDocumentFields on it (10900)`);
    }
    // #5215 (5.0): a settled document is deleted only by the team, so the team must be able to delete it.
    if (schema.moderatorAbilities?.deleteSettled && !(moderated[docType] ?? []).includes('deleteDocuments')) {
      problems.push(`"${docType}" sets moderatorAbilities.deleteSettled but the moderated set does not give the team deleteDocuments on it (10900)`);
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

// ---- Index shapes (rs-dpp validate_index_properties, `validation` feature) ----

/** System properties an index may name (`$id` is refused: it is indexed already, 10208). */
const INDEXABLE_SYSTEM_PROPERTIES = new Set(['$ownerId', '$creatorId', '$createdAt', '$updatedAt', '$transferredAt',
  '$createdAtBlockHeight', '$updatedAtBlockHeight', '$transferredAtBlockHeight', '$createdAtCoreBlockHeight',
  '$updatedAtCoreBlockHeight', '$transferredAtCoreBlockHeight', '$moderatedBy', '$moderatedAt']);
const MAX_INDEXES = 10;
const MAX_INDEXED_STRING_LENGTH = 63;
const MAX_INDEXED_BYTE_ARRAY_LENGTH = 255;

/** A property definition by its (possibly dotted) path, as rs-dpp's flattened properties hold it. */
function propertyAt(schema, path) {
  let properties = schema.properties;
  let definition;
  for (const part of path.split('.')) {
    definition = properties?.[part];
    if (!definition) return undefined;
    properties = definition.properties;
  }
  return definition;
}

/**
 * The index shape rules (V10-DESIGN §0, ported from index-audit.py): every
 * property exists or is a system property other than `$id`; none is an
 * object, a plain array or a typed array (10206); indexed strings are at most
 * 63 characters and byte arrays at most 255 bytes (10205); at most 10 indexes
 * with distinct names. wasm-dpp2 refuses the same shapes; the wasm-sdk parse
 * accepts every one of them.
 */
function auditIndexShapes(schemas) {
  const problems = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const indices = schema.indices ?? [];
    if (indices.length > MAX_INDEXES) problems.push(`${name}: ${indices.length} indexes, above ${MAX_INDEXES} (10101)`);
    const names = indices.map((index) => index.name);
    if (new Set(names).size !== names.length) problems.push(`${name}: duplicate index names`);
    for (const index of indices) {
      for (const entry of index.properties ?? []) {
        const [property] = Object.keys(entry);
        if (property === '$id') { problems.push(`${name}.${index.name}: $id is indexed already (10208)`); continue; }
        if (INDEXABLE_SYSTEM_PROPERTIES.has(property)) continue;
        const definition = propertyAt(schema, property);
        // 5.0.0-beta.1 derived index property: "<reference property>.<field>" read through a refersTo (#5216).
        if (!definition && property.includes('.') && schema.properties?.[property.split('.')[0]]?.refersTo) continue;
        if (!definition) { problems.push(`${name}.${index.name}: "${property}" is not a property of the type (10209)`); continue; }
        if (definition.type === 'object' || (definition.type === 'array' && definition.byteArray !== true)) {
          problems.push(`${name}.${index.name}: "${property}" is ${definition.items ? 'a typed array' : `an ${definition.type}`} and cannot be indexed (10206)`);
        } else if (definition.type === 'string' && !(definition.maxLength <= MAX_INDEXED_STRING_LENGTH)) {
          problems.push(`${name}.${index.name}: indexed string "${property}" has maxLength ${definition.maxLength ?? 'unbounded'}, above ${MAX_INDEXED_STRING_LENGTH} (10205)`);
        } else if (definition.byteArray === true && !(definition.maxItems <= MAX_INDEXED_BYTE_ARRAY_LENGTH)) {
          problems.push(`${name}.${index.name}: indexed byte array "${property}" has maxItems ${definition.maxItems ?? 'unbounded'}, above ${MAX_INDEXED_BYTE_ARRAY_LENGTH} (10205)`);
        }
      }
    }
  }
  return problems;
}

/**
 * The node-side registration rules Yappr's cuts depend on. Returns a list of
 * problems (empty = the node would accept on these counts). `network` picks
 * the election-window floor: one day on mainnet, 0 elsewhere (#5108). Yappr's
 * cuts register on a devnet, so devnet is the default.
 */
export function auditNodeRules(source, { network = 'devnet' } = {}) {
  const problems = [];
  const schemas = source.documentSchemas;
  const config = source.config ?? {};
  const moderation = config.moderation;

  if (moderation) {
    if (config.$formatVersion !== '2') problems.push('config.moderation needs config.$formatVersion "2" (a "1" config drops it)');
    const anyList = moderation.banlist || moderation.suspensions || moderation.warnings;
    const anyAbility = Object.values(schemas).some((s) => moderatorsMayDelete(s) || moderatorsMayChangeFields(s));
    if (!anyList && !anyAbility) problems.push('moderation keeps no list and no type gives its moderators an ability (10900)');
    const moderators = moderation.moderators ?? {};
    if (moderators.$type === 'appointedModerators') {
      const ids = moderators.identities ?? [];
      if (ids.length === 0 || ids.length > LIMITS.maxModerators) problems.push(`${ids.length} appointed moderators; 1 to ${LIMITS.maxModerators} allowed (10900)`);
    } else if (moderators.$type === 'elected') {
      problems.push(...auditElected(moderators, moderation, schemas, { network }));
    }
    if (moderators.$type !== 'elected') {
      for (const [docType, schema] of Object.entries(schemas)) {
        if (schema.moderatorAbilities?.deleteSettled) problems.push(`"${docType}" sets moderatorAbilities.deleteSettled, which needs an elected team (10231)`);
      }
    }
  }

  problems.push(...auditIndexShapes(schemas));
  for (const [name, schema] of Object.entries(schemas)) {
    for (const [path, definition] of Object.entries(schema.properties ?? {})) {
      if (definition.items && definition.maxItems > LIMITS.maxTypedArrayItems) {
        problems.push(`${name}.${path}: typed array maxItems ${definition.maxItems} exceeds ${LIMITS.maxTypedArrayItems}`);
      }
    }
    const budget = referenceBudget(schema);
    if (budget > LIMITS.maxReferencesPerDocument) problems.push(`${name}: up to ${budget} references per document, above ${LIMITS.maxReferencesPerDocument}`);
    // #4983: a single deletableDocument reference by id, declared as the whole
    // refersTo (not inside anyOf/allOf, not found by findBy), may be cleared once its
    // target is gone, so it may not also be settable while absent. rs-dpp matches the
    // whole target, not its leaves. 5.0.0-beta.1 states it on the conditional
    // `immutable` entry that replaced `immutableAllowSetting`: such a reference is
    // listed only without a condition (try_from_schema/v3 immutable_tests.rs).
    for (const entry of schema.immutable ?? []) {
      if (typeof entry === 'string') continue;
      const ref = schema.properties?.[entry.property]?.refersTo;
      if (ref?.type === 'deletableDocument' && !ref.findBy) {
        problems.push(`${name}.${entry.property}: a conditional immutable entry on a deletableDocument reference (#4983)`);
      }
    }
    for (const [path, ref, inExpression] of referenceDeclarations(schema)) {
      // validate_no_immutable_deletable_element_references: a deletableDocument found by
      // findBy, a typed array of deletable refs, or a by-id deletable ref inside an object,
      // held under an `immutable` top-level property, could never be re-validated once its
      // target is gone, so the type could never be replaced.
      const topLevel = path.split('.')[0].replace(/\[\]$/, '');
      // rs-dpp `lists_as_immutable`: listed with a condition or without, alike.
      const heldImmutably = (schema.immutable ?? []).some((entry) => entry === topLevel || entry?.property === topLevel);
      const isList = path.endsWith('[]');
      const nested = path.replace(/\[\]$/, '') !== topLevel;
      if (heldImmutably && ref.type === 'deletableDocument' && (ref.findBy || isList || (nested && !inExpression))) {
        const heldAs = ref.findBy ? 'findBy reference' : isList ? 'typed array' : 'reference inside an object';
        problems.push(`${name}.${path}: a deletableDocument ${heldAs} under \`immutable\``);
      }
      // #4982: an immutable contract reference with an owner requirement on a type whose
      // documents can change owner could never be replaced by the new owner. rs-dpp reads
      // `owner` as present only when it names a relation (a JSON null is none).
      const ownerRequirement = ref.contractRequirements?.owner;
      if (heldImmutably && ref.type === 'contract' && ownerRequirement !== undefined && ownerRequirement !== null && ownerCanChange(schema)) {
        problems.push(`${name}.${path}: immutable contract reference with an owner requirement on a transferable type (#4982)`);
      }
      if (ref.contractId || !ref.documentType || !DOCUMENT_REFERENCE_KINDS.includes(ref.type)) continue;
      const target = schemas[ref.documentType];
      if (!target) { problems.push(`${name}.${path}: refersTo unknown document type "${ref.documentType}"`); continue; }
      // 40126, judged against the whole contract at registration: both sides of a
      // `where` entry must exist and hold the same type of value.
      for (const [referenced, referring] of Object.entries(ref.where ?? {})) {
        const theirs = referenced.startsWith('$') ? { system: referenced } : propertyAt(target, referenced);
        const mine = referring.startsWith('$') ? { system: referring } : propertyAt(schema, referring);
        if (!theirs) problems.push(`${name}.${path}: where names "${referenced}", which "${ref.documentType}" does not have (40126)`);
        if (!mine) problems.push(`${name}.${path}: where reads "${referring}", which "${name}" does not have (40126)`);
        if (theirs?.type && mine?.type && (theirs.type !== mine.type || (theirs.byteArray === true) !== (mine.byteArray === true))) {
          problems.push(`${name}.${path}: where compares "${referenced}" (${theirs.type}) with "${referring}" (${mine.type}) (40126)`);
        }
      }
      const mismatch = referenceKindMismatch(ref.type, target, config);
      if (mismatch) problems.push(`${name}.${path}: "${ref.documentType}" ${mismatch}`);
    }
  }
  return problems;
}

// ---- Negative probes ---------------------------------------------------------

const SOCIAL_V10 = 'contracts/yappr-social-contract-v10.json';
const SOCIAL_V11 = 'contracts/yappr-social-contract-v11.json';
const SOCIAL_V12 = 'contracts/yappr-social-contract-v12.json';
const SOCIAL_V13 = 'contracts/yappr-social-contract-v13.json';
const BLOCKS = 'contracts/yappr-blocks-contract.json';
const SOCIAL_V9 = 'contracts/yappr-social-contract-v9.json';
const STOREFRONT = 'contracts/yappr-storefront-contract.json';
const PROFILE = 'contracts/yappr-profile-contract.json';
const BLOG = 'contracts/yappr-blog-contract.json';

const elected = (source) => source.config.moderation.moderators;
const types = (source) => source.documentSchemas;
let v12Json;
/** The committed v12 file, read once (the v11 → v12 update probe copies its types). */
const v12Source = () => (v12Json ??= JSON.parse(readFileSync(SOCIAL_V12, 'utf8')));
const namedIndex = (source, type, name) => types(source)[type].indices.find((i) => i.name === name);
/** v12 keeping warnings only: no banlist, no suspensions, and no ban/suspend ability they back. */
function withoutBars(source) {
  Object.assign(source.config.moderation, { banlist: false, suspensions: false });
  const moderated = elected(source).moderatedDocumentTypes;
  for (const [type, abilities] of Object.entries(moderated)) moderated[type] = abilities.filter((a) => a !== 'ban' && a !== 'suspend');
}
/** yapprProfile with a week's delete window and post's settled rule, $createdAt no longer required; answers the rule. */
function settledWithoutCreatedAt(source) {
  const profile = types(source).yapprProfile;
  profile.required = profile.required.filter((p) => p !== '$createdAt');
  profile.moderatorAbilities = { delete: true, deleteWithin: 604_800, deleteSettled: { leader: true, approvals: 3 } };
  return profile.moderatorAbilities.deleteSettled;
}
const identifier = (position, refersTo) => ({ type: 'array', byteArray: true, minItems: 32, maxItems: 32, contentMediaType: 'application/x.dash.dpp.identifier', position, ...(refersTo ? { refersTo } : {}) });
/** Every same-contract document type a source's references name. */
const referencedTypes = (source) => Object.values(types(source)).flatMap((schema) => referenceDeclarations(schema).map(([, ref]) => ref.documentType)).filter(Boolean);

/**
 * Each probe mutates a committed cut and records the first layer that refuses
 * it: `wasm` = the wasm-sdk parse, `dpp2` = parses in the wasm-sdk but the
 * wasm-dpp2 parse (meta-schema + `validation`) refuses it, `audit` = both
 * parse and only `auditNodeRules` (or the size cap) refuses it — the node
 * does, and the SDK signs it — or `accepted` for a control. `auditToo` also
 * requires the audit to flag a `dpp2` probe, pinning the ported index checks.
 * An `update` probe (in place of `mutate`) edits version 2 of the cut, and
 * `update` is its refusal by the update rules; its first refusal must carry the
 * probe's `node` code. `why` must match the refusal's text: a probe refused by
 * some other rule first proves nothing about its own.
 */
const PROBES = [
  { label: 'control: social v10 as committed', file: SOCIAL_V10, mutate: () => {}, expect: 'accepted' },
  { label: 'control: social v11 as committed', file: SOCIAL_V11, mutate: () => {}, expect: 'accepted' },
  { label: 'control: storefront as committed', file: STOREFRONT, mutate: () => {}, expect: 'accepted' },
  { label: 'control: blog as committed', file: BLOG, mutate: () => {}, expect: 'accepted' },
  { label: 'control: pollr as committed', file: 'contracts/pollr-contract.json', mutate: () => {}, expect: 'accepted' },
  { label: 'control: profile (testnet profile topology v2) as committed', file: PROFILE, mutate: () => {}, expect: 'accepted' },
  // The beta.6 grammar no longer parses anywhere from beta.7 on (#5197): social v9 is readable
  // by a beta.6 SDK only, and a beta.7 or later node would not load it.
  { label: 'social v9 (beta.6 propertyAgreement/lookup grammar) is refused', file: SOCIAL_V9, mutate: () => {}, expect: 'wasm' },
  // 5.0.0-beta.1 (#5217) refuses `immutableAllowSetting` on every parse, so the beta.7 blog
  // (topology v5, live on bonsia) loads nowhere on 5.0: not in the SDK, not on a node.
  { label: 'blog in its beta.7 shape (immutableAllowSetting publishedAt) is refused on 5.0', file: BLOG, expect: 'wasm', mutate: (s) => {
    const t = types(s).blogPost;
    t.immutable = ['blogId', 'publishedAt']; t.immutableAllowSetting = ['publishedAt'];
    // Not blogComment.blogPostId: postOwnerAndTime derives through it, and a deletable
    // reference there is refused for that first (pinned below).
    for (const [type, property] of [['blogPost', 'blogId'], ['blogFollow', 'blogId']]) types(s)[type].properties[property].refersTo.type = 'deletableDocument';
  } },
  // #5214: blog and blogPost are moderated-kind (canBeDeleted false, no ttl, a moderator
  // delete keeping records). Both parses accept the beta.7 `deletableDocument` references at
  // blog; registration refuses each one with 40144. (blogComment's reference at blogPost is
  // refused by the parse itself: postOwnerAndTime derives through it, below.)
  { label: 'blog with its beta.7 deletableDocument references at the moderated blog', file: BLOG, expect: 'audit', node: '40144', mutate: (s) => {
    for (const [type, property] of [['blogPost', 'blogId'], ['blogFollow', 'blogId']]) types(s)[type].properties[property].refersTo.type = 'deletableDocument';
  } },
  { label: 'blog moderatedDocument reference at a blogPost its owner may delete', file: BLOG, expect: 'audit', node: '40143', mutate: (s) => { types(s).blogPost.canBeDeleted = true; } },
  { label: 'blog moderatedDocument reference at a blogPost whose removals keep no record', file: BLOG, expect: 'audit', node: '40143', mutate: (s) => { types(s).blogPost.moderatorAbilities.deleteKeepsRecord = false; } },
  // #5216: blog v6's postOwnerAndTime reads `blogPostId.$ownerId` through the reference, and a
  // derived property needs a permanent or moderated reference.
  { label: 'blog postOwnerAndTime deriving through a deletableDocument reference', file: BLOG, expect: 'wasm', mutate: (s) => {
    types(s).blogPost.canBeDeleted = true; types(s).blogComment.properties.blogPostId.refersTo.type = 'deletableDocument';
  } },

  // Social v11 (5.0.0-beta.1): outlivesDelete (#5232/#5233), deleteKeepsFields (#5219),
  // deleteWithin + deleteSettled (#5215). index-only.md and deletion.md list the rules.
  { label: 'v11: outlivesDelete on a window whose key holds no cleared index key ([$createdAt] → $ownerId)', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => {
    types(s).like.indices.push({ name: 'probe', properties: [{ $createdAt: 'asc' }], terminal: '$ownerId', countable: 'countable', timeRange: { on: '$createdAt', range: 3600, step: 3600, ttl: 3600 }, outlivesDelete: true });
  } },
  { label: 'v11: outlivesDelete on a window without a ttl', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { delete types(s).like.indices.find((i) => i.name === 'byTrendPost').timeRange.ttl; } },
  { label: 'v11: outlivesDelete on an index with no timeRange (byPost)', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).like.indices.find((i) => i.name === 'byPost').outlivesDelete = true; } },
  { label: 'v11: outlivesDelete on a stored type\'s window (post.quotedPostOwnerRecent)', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.indices.find((i) => i.name === 'quotedPostOwnerRecent').outlivesDelete = true; } },
  { label: 'v11: the trend windows outlive deletes while the author index keeps $createdAt (rows still commit to the time; legal, saves nothing)', file: SOCIAL_V11, expect: 'accepted', mutate: (s) => {
    const index = types(s).like.indices.find((i) => i.name === 'byAuthorPost');
    index.name = 'byAuthorPostTime'; index.properties.push({ $createdAt: 'asc' }); delete index.preallocated;
  } },
  { label: 'v11: deleteSettled without deleteWithin', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { delete types(s).post.moderatorAbilities.deleteWithin; } },
  { label: 'v11: deleteSettled with 0 approvals', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteSettled.approvals = 0; } },
  { label: 'v11: deleteSettled asking for 27 approvals (the leader, 15 elected and 10 added hold 26)', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteSettled.approvals = 27; } },
  { label: 'v11: deleteSettled on a type the elected team may not delete', file: SOCIAL_V11, expect: 'audit', node: '10900', mutate: (s) => { elected(s).moderatedDocumentTypes.post = ['ban', 'suspend', 'warn']; } },
  { label: 'v11: a deleteWithin of 0 s', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteWithin = 0; } },
  { label: 'v11: deleteKeepsFields naming $id', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteKeepsFields.push('$id'); } },
  { label: 'v11: deleteKeepsFields naming a property post does not have', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteKeepsFields.push('nope'); } },
  { label: 'v11: deleteKeepsFields naming $transferredAt, which post does not require', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteKeepsFields.push('$transferredAt'); } },
  // Design M: moderated post/reply, moderatedDocument references, preallocated like trees, tombstones.
  { label: 'v11 M: a deletableDocument reference at the moderated post (like.postId; the preallocated trees refuse it first, the node would also say 40144)', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).like.properties.postId.refersTo.type = 'deletableDocument'; } },
  { label: 'v11 M: a moderatedDocument reference at an author-deletable post', file: SOCIAL_V11, expect: 'audit', node: '40143', mutate: (s) => { delete types(s).post.canBeDeleted; } },
  { label: 'v11 M: preallocated byHashtagPost when the removal record does not keep hashtag', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteKeepsFields = ['$createdAt']; } },
  { label: 'v11 M: preallocated on a windowed index (byTrendPost)', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).like.indices.find((i) => i.name === 'byTrendPost').preallocated = true; } },
  { label: 'v11 M: preallocated on a stored type\'s count index (post.quotesOfPost)', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.indices.find((i) => i.name === 'quotesOfPost').preallocated = true; } },
  { label: 'v11 M: a tombstone that may be undone (deleted not frozen once set): legal, so the freeze is the cut\'s choice', file: SOCIAL_V11, expect: 'accepted', mutate: (s) => { types(s).post.immutable = types(s).post.immutable.filter((e) => e.property !== 'deleted'); } },
  { label: 'v11 M: a conditional freeze on the hashtag a preallocated index keys: legal (the trees stay keyed by the created value), so the cut freezes hashtag by name', file: SOCIAL_V11, expect: 'accepted', mutate: (s) => { const t = types(s).post; t.immutable = t.immutable.map((e) => (e === 'hashtag' ? { property: 'hashtag', when: { absent: 'deleted' } } : e)); } },
  { label: 'v11 M: a derived quote-owner index on a quote that a tombstone clears', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.indices.push({ name: 'probe', properties: [{ $createdAt: 'asc' }, { 'quotedPostId.$ownerId': 'asc' }], timeRange: { on: '$createdAt', range: 302400, step: 302400, ttl: 604800 } }); } },
  { label: 'v11 M: a derived root-owner index on a reply (rootPostId frozen): legal, not adopted (SOCIAL_V11.md)', file: SOCIAL_V11, expect: 'accepted', mutate: (s) => { types(s).reply.indices.push({ name: 'probe', properties: [{ $createdAt: 'asc' }, { 'rootPostId.$ownerId': 'asc' }], timeRange: { on: '$createdAt', range: 302400, step: 302400, ttl: 604800 } }); } },
  { label: 'v11 M: a derived post-owner index on the indexOnly like', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).like.indices.push({ name: 'probe', properties: [{ 'postId.$ownerId': 'asc' }, { postId: 'asc' }], terminal: '$ownerId' }); } },
  { label: 'v11: deleteKeepsFields beside deleteKeepsRecord false', file: SOCIAL_V11, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteKeepsRecord = false; } },

  // Social v12 (5.0.0-beta.2): counter indexes (`summableOffCountIndex`, #5250; index-only.md
  // "summableOffCountIndex"), `retractedWhen` (#5253; deletion.md) and the dated settled
  // deletion (`approversPredateDocument`, #5260). `why` pins the rule a refusal names, so a
  // probe refused for some other reason first does not pass as this one.
  { label: 'control: social v12 as committed', file: SOCIAL_V12, mutate: () => {}, expect: 'accepted' },
  { label: 'v12 counter: byAuthorPost without rangeSummable (the counters sit in the last property\'s sum tree)', file: SOCIAL_V12, expect: 'wasm', why: /needs rangeSummable/i, mutate: (s) => { delete namedIndex(s, 'like', 'byAuthorPost').rangeSummable; } },
  { label: 'v12 counter: byAuthorPost with a terminal', file: SOCIAL_V12, expect: 'wasm', why: /takes no terminal/i, mutate: (s) => { namedIndex(s, 'like', 'byAuthorPost').terminal = '$ownerId'; } },
  { label: 'v12 counter: byAuthorPost also `summable` (one summed value per type)', file: SOCIAL_V12, expect: 'wasm', why: /no summable or averageable/i, mutate: (s) => { namedIndex(s, 'like', 'byAuthorPost').summable = 'postId'; } },
  // A source that skips: byPost holds only the required postId, so `skipIfAbsent` there is refused
  // by the skip rules too; `why` reports which rule spoke first.
  { label: 'v12 counter: its source byPost skips (skipIfAbsent)', file: SOCIAL_V12, expect: 'wasm', why: /sums the count of "byPost", which must/i, mutate: (s) => { namedIndex(s, 'like', 'byPost').skipIfAbsent = true; } },
  // A source that outlives deletes is a window (outlivesDelete needs a timeRange, which needs
  // $createdAt): every counter names byTrendPost, which breaks both source rules.
  { label: 'v12 counter: both like counters count off byTrendPost (a window that outlives deletes and involves $createdAt)', file: SOCIAL_V12, expect: 'wasm', why: /sums the count of "byTrendPost", which must/i, mutate: (s) => {
    for (const name of ['byAuthorPost', 'byHashtagPost']) namedIndex(s, 'like', name).summableOffCountIndex = 'byTrendPost';
  } },
  // Lossless: postAuthor is fixed only by the postId reference's `"$ownerId": "postAuthor"`.
  // Without it the preallocation rule speaks first (the counter's path is no longer named by
  // the post); without preallocation too, the counter's own rule does.
  { label: 'v12 counter: the like.postId where loses "$ownerId": "postAuthor" (preallocated byAuthorPost loses its path first)', file: SOCIAL_V12, expect: 'wasm', why: /preallocated/i, mutate: (s) => { delete types(s).like.properties.postId.refersTo.where.$ownerId; } },
  { label: 'v12 counter: the same on an unpreallocated byAuthorPost (postAuthor is neither in the source nor fixed by it)', file: SOCIAL_V12, expect: 'wasm', why: /postAuthor.{0,40}neither a property of its source/i, mutate: (s) => {
    delete types(s).like.properties.postId.refersTo.where.$ownerId;
    delete namedIndex(s, 'like', 'byAuthorPost').preallocated;
  } },
  { label: 'v12 counter: byAuthorPost with a timeRange', file: SOCIAL_V12, expect: 'wasm', why: /cannot declare timeRange/i, mutate: (s) => {
    const counter = namedIndex(s, 'like', 'byAuthorPost');
    counter.properties = [{ $createdAt: 'asc' }, ...counter.properties];
    counter.timeRange = { on: '$createdAt', range: 86_400, step: 86_400, ttl: 172_800 };
    delete counter.preallocated;
    delete counter.rankedCountable;
  } },
  { label: 'v12 counter: another index continues below byAuthorPost\'s last property ([postAuthor, postId, hashtag] → $ownerId)', file: SOCIAL_V12, expect: 'wasm', why: /is continued by index "probe"/i, mutate: (s) => {
    types(s).like.indices.push({ name: 'probe', properties: [{ postAuthor: 'asc' }, { postId: 'asc' }, { hashtag: 'asc' }], terminal: '$ownerId', skipIfAbsent: true });
  } },
  // A second entries index over the post, [postId, $ownerId], is a legal source on its own;
  // byHashtagPost naming it while byAuthorPost names byPost is two summed values.
  { label: 'v12 counter: two like counters naming different sources (byPost, and a second [postId, $ownerId] index)', file: SOCIAL_V12, expect: 'wasm', why: /sums the count of "byPost", but index "byHashtagPost"/i, mutate: (s) => {
    types(s).like.indices.push({ name: 'byPostOwner', properties: [{ postId: 'asc' }, { $ownerId: 'asc' }] });
    namedIndex(s, 'like', 'byHashtagPost').summableOffCountIndex = 'byPostOwner';
  } },
  { label: 'v12 counter: likeReply byAuthorReply counting off itself', file: SOCIAL_V12, expect: 'wasm', mutate: (s) => { namedIndex(s, 'likeReply', 'byAuthorReply').summableOffCountIndex = 'byAuthorReply'; } },
  { label: 'v12: rankedSummable { at } on a stored type\'s index (post.ownerAndTime), which is no counter', file: SOCIAL_V12, expect: 'wasm', why: /`at` form is only allowed on a summableOffCountIndex index/i, mutate: (s) => { namedIndex(s, 'post', 'ownerAndTime').rankedSummable = { at: ['$ownerId'] }; } },
  { label: 'v12: rankedSummable { at } on like.byTrendPost (keeps entries, no counter)', file: SOCIAL_V12, expect: 'wasm', why: /`at` form is only allowed on a summableOffCountIndex index/i, mutate: (s) => { namedIndex(s, 'like', 'byTrendPost').rankedSummable = { at: ['postId'] }; } },
  { label: 'v12 counter: byAuthorReply ranked at [replyAuthor] (rankedCountable merges into the sum ranking; legal, not adopted)', file: SOCIAL_V12, expect: 'accepted', mutate: (s) => { namedIndex(s, 'likeReply', 'byAuthorReply').rankedCountable = { at: ['replyAuthor'] }; } },
  { label: 'v12: retractedWhen on like, whose documents are not mutable', file: SOCIAL_V12, expect: 'wasm', why: /retractedWhen.{0,40}not mutable/i, mutate: (s) => { types(s).like.retractedWhen = { present: 'hashtag' }; } },
  { label: 'v12: retractedWhen on follow, whose documents are not mutable', file: SOCIAL_V12, expect: 'wasm', why: /retractedWhen.{0,40}not mutable/i, mutate: (s) => { types(s).follow.retractedWhen = { present: 'followingId' }; } },
  // Only a banlist or a suspension list bars anyone: the control drops both lists (and the
  // abilities they back) and keeps the warnings, so the probe differs by retractedWhen alone.
  { label: 'v12: a warnings-only contract without retractedWhen (control for the next probe)', file: SOCIAL_V12, expect: 'accepted', mutate: (s) => { withoutBars(s); for (const type of ['post', 'reply']) delete types(s)[type].retractedWhen; } },
  { label: 'v12: retractedWhen on a contract that keeps neither a banlist nor a suspension list', file: SOCIAL_V12, expect: 'wasm', why: /retractedWhen.{0,200}(banlist|suspension)/i, mutate: (s) => { withoutBars(s); } },
  { label: 'v12: retractedWhen reading a property post does not have', file: SOCIAL_V12, expect: 'wasm', mutate: (s) => { types(s).post.retractedWhen = { present: 'nope' }; } },
  // #5260: a settled deletion needing several approvals dates the leader's added members by
  // $createdAt. yapprProfile (mutable, moderator-deletable, deleteDocuments in the elected set)
  // takes a deleteSettled here; `$updatedAt` stays required as deleteWithin's clock.
  { label: 'v12: deleteSettled approvals 3 on a type that does not require $createdAt (#5260)', file: SOCIAL_V12, expect: 'wasm', why: /createdAt|approversPredateDocument/i, mutate: (s) => { settledWithoutCreatedAt(s); } },
  { label: 'v12: the same with approversPredateDocument false (members count whenever added)', file: SOCIAL_V12, expect: 'accepted', mutate: (s) => { settledWithoutCreatedAt(s).approversPredateDocument = false; } },
  { label: 'v12: the same with one approval (the leader alone; nobody is dated by default)', file: SOCIAL_V12, expect: 'accepted', mutate: (s) => { const rule = settledWithoutCreatedAt(s); rule.approvals = 1; } },

  // Contract updates (wasm-dpp2 `validateUpdate`, the code a data contract update runs): the
  // committed file is version 1, `update` builds version 2. `retractedWhen`, the counter and
  // `deleteSettled` are fixed once a type exists (40212 / 10217).
  { label: 'v12 update: version 2 changing nothing (control)', file: SOCIAL_V12, expect: 'accepted', update: () => {} },
  { label: 'v12 update: retractedWhen changed on post', file: SOCIAL_V12, expect: 'update', node: '40212', why: /retractedWhen/i, update: (s) => { types(s).post.retractedWhen = { anyOf: [{ present: 'deleted' }, { absent: 'content' }] }; } },
  { label: 'v12 update: retractedWhen removed from reply', file: SOCIAL_V12, expect: 'update', node: '40212', why: /retractedWhen/i, update: (s) => { delete types(s).reply.retractedWhen; } },
  { label: 'v11 update: retractedWhen added to a stored post', file: SOCIAL_V11, expect: 'update', node: '40212', why: /retractedWhen/i, update: (s) => { types(s).post.retractedWhen = { present: 'deleted' }; } },
  { label: 'v12 update: approversPredateDocument turned off on post', file: SOCIAL_V12, expect: 'update', node: '40212', why: /who must approve/i, update: (s) => { types(s).post.moderatorAbilities.deleteSettled.approversPredateDocument = false; } },
  // A counter's source can only be byPost (every source property must be the counter's, and a
  // second [postId] index is a duplicate), so the update probes turn entries into counters and
  // back: the index is frozen whole.
  { label: 'v12 update: byHashtagPost back to v11\'s entries index (terminal $ownerId, no counter)', file: SOCIAL_V12, expect: 'update', node: '10217', why: /changed index 'byHashtagPost'/i, update: (s) => {
    const tags = namedIndex(s, 'like', 'byHashtagPost');
    delete tags.summableOffCountIndex; delete tags.rangeSummable; tags.terminal = '$ownerId';
  } },
  { label: 'v11 update: v11 updated in place to v12\'s like, likeReply, post and reply (counters and retractedWhen)', file: SOCIAL_V11, expect: 'update', node: '10217', why: /changed index 'byAuthor(Post|Reply)'|changed index 'byHashtagPost'/i, update: (s) => {
    for (const type of ['like', 'likeReply', 'post', 'reply']) types(s)[type] = structuredClone(types(v12Source())[type]);
  } },

  // Social v13 (the mainnet candidate) and the blocks contract split out of it. `network`
  // renders the file as that network registers it (`withInterim`): mainnet's interim is
  // notYetUsable. `holds` is a statement about the loaded source that must be true.
  { label: 'control: social v13 as committed (devnet: interim contractOwner)', file: SOCIAL_V13, mutate: () => {}, expect: 'accepted', holds: (s) => elected(s).interim.$type === 'contractOwner' },
  { label: 'control: social v13 as mainnet registers it (interim notYetUsable, one-day window floor)', file: SOCIAL_V13, network: 'mainnet', mutate: () => {}, expect: 'accepted', holds: (s) => elected(s).interim.$type === 'notYetUsable' },
  { label: 'control: the blocks contract as committed (bare schemas, unmoderated)', file: BLOCKS, mutate: () => {}, expect: 'accepted', holds: (s) => !s.config.moderation && types(s).block.indices.every((i) => i.name !== 'ownerBlocks') },
  { label: 'v13: no block type is left in social, and nothing in it refers to one', file: SOCIAL_V13, mutate: () => {}, expect: 'accepted', holds: (s) => {
    const blockTypes = ['block', 'blockFilter', 'blockFollow'];
    return blockTypes.every((t) => !types(s)[t]) && !referencedTypes(s).some((t) => blockTypes.includes(t)) && !JSON.stringify(s.config).includes('block');
  } },
  // `live` is const true, optional, and frozen while the post is not a tombstone: read back off
  // the PARSED contract, so a keyword the parser dropped would fail here.
  { label: 'v13: the parsed post keeps `live` const true and frozen unless tombstoned (immutableWhen)', file: SOCIAL_V13, mutate: () => {}, expect: 'accepted', holds: (_s, parsed) => {
    const live = parsed.schemas.post?.properties?.live;
    const frozen = parsed.documentTypeImmutableProperties('post').immutableWhen ?? {};
    return live?.const === true && JSON.stringify(frozen.live) === JSON.stringify({ absent: 'deleted' });
  } },
  { label: 'v13 on mainnet with v12\'s 3600 s election windows', file: SOCIAL_V13, network: 'mainnet', expect: 'audit', node: '10900', mutate: (s) => { elected(s).joinWindow = 3600; elected(s).voteWindow = 3600; } },
  { label: 'v13: a contestable seat with a 13-day challenge cool-down (two weeks minimum)', file: SOCIAL_V13, expect: 'audit', node: '10900', mutate: (s) => { elected(s).challengeCoolDown = 1_123_200; } },
  // The report target rule cannot be arithmetic: `count` reads arrays and byte arrays, not identifiers.
  { label: 'v13: report oneTarget as arithmetic over the identifiers (count of postId)', file: SOCIAL_V13, expect: 'wasm', why: /counts the items of "postId"/i, mutate: (s) => {
    types(s).report.propertyConstraints.oneTarget = { in: [{ add: [{ count: 'postId' }, { count: 'replyId' }, 'about'] }, [1, 32]] };
  } },
  { label: 'v13: the media rule measuring mediaUrls with `length` (a typed array is counted, not measured)', file: SOCIAL_V13, expect: 'wasm', why: /measures the length of "mediaUrls"/i, mutate: (s) => {
    types(s).post.propertyConstraints.media.allOf[1] = { equal: [{ length: 'mediaUrls' }, { count: 'mediaKinds' }] };
  } },
  { label: 'v13: parentIsRoot comparing parentOwnerId with itself', file: SOCIAL_V13, expect: 'wasm', why: /compares "parentOwnerId" with itself/i, mutate: (s) => {
    types(s).reply.propertyConstraints.parentIsRoot = { ifThen: [{ absent: 'replyToReplyId' }, { equal: ['parentOwnerId', 'parentOwnerId'] }] };
  } },
  // `live` is optional so that ownerAndTime can skip a tombstone; required, the index could never skip.
  { label: 'v13: live required (ownerAndTime\'s skipIfAbsent could never skip a tombstone)', file: SOCIAL_V13, expect: 'wasm', why: /none of its properties is optional/i, mutate: (s) => { types(s).post.required.push('live'); } },
  { label: 'v13: the reply\'s rootPostId where naming a rootOwnerId the post does not have', file: SOCIAL_V13, expect: 'audit', node: '40126', mutate: (s) => { types(s).reply.properties.rootPostId.refersTo.where = { rootOwnerId: 'rootOwnerId' }; } },
  { label: 'v13: the nested reply\'s where comparing the parent\'s rootPostId with a string', file: SOCIAL_V13, expect: 'audit', node: '40126', mutate: (s) => { types(s).reply.properties.replyToReplyId.refersTo.where.rootPostId = 'content'; } },
  // Updates: what can follow v13 without a new contract. An elected declaration, its interim
  // included, is frozen (40002), so mainnet must register notYetUsable from the start.
  { label: 'v13 update: the interim swapped to notYetUsable after registration', file: SOCIAL_V13, expect: 'update', node: '40002', why: /elected moderation declaration/i, update: (s) => { elected(s).interim = { $type: 'notYetUsable' }; } },
  { label: 'v13 update: a second report kind (report.about maximum 2): accepted, so profile is not the last identity target', file: SOCIAL_V13, expect: 'accepted', update: (s) => { types(s).report.properties.about.maximum = 2; } },
  { label: 'v13 update: a new optional report property: accepted', file: SOCIAL_V13, expect: 'accepted', update: (s) => { types(s).report.properties.probe = { type: 'integer', minimum: 1, maximum: 3, position: 9 }; } },
  { label: 'v13 update: post.ownerAndTime back to v12\'s [$ownerId, $createdAt]', file: SOCIAL_V13, expect: 'update', node: '10217', why: /changed index 'ownerAndTime'/i, update: (s) => {
    const index = namedIndex(s, 'post', 'ownerAndTime');
    index.properties = index.properties.slice(1); delete index.skipIfAbsent;
  } },
  { label: 'v13 update: the media rule relaxed (rules are fixed)', file: SOCIAL_V13, expect: 'update', node: '10246', why: /propertyConstraints/i, update: (s) => { types(s).post.propertyConstraints.media = { equal: [{ count: 'mediaUrls' }, { count: 'mediaKinds' }] }; } },

  // Elected declaration (config/moderation/elected.rs): basic-structure rules of the
  // create transition, refused by the node with 10900. The one-day floor is mainnet's only
  // (#5108), so v10's 3600 s windows are legal on a devnet.
  { label: 'elected windows of 0 s off mainnet (control)', file: SOCIAL_V10, expect: 'accepted', mutate: (s) => { elected(s).joinWindow = 0; elected(s).voteWindow = 0; } },
  { label: 'elected joinWindow of 3600 s on mainnet', file: SOCIAL_V10, network: 'mainnet', expect: 'audit', node: '10900', mutate: () => {} },
  { label: 'elected voteWindow over four weeks', file: SOCIAL_V10, expect: 'audit', node: '10900', mutate: (s) => { elected(s).voteWindow = 2_419_201; } },
  { label: 'elected maxAddedModerators 16', file: SOCIAL_V10, expect: 'audit', node: '10900', mutate: (s) => { elected(s).maxAddedModerators = 16; } },
  { label: 'elected warn ability without a warning list', file: SOCIAL_V10, expect: 'audit', node: '10900', mutate: (s) => { s.config.moderation.warnings = false; } },
  { label: 'elected deleteDocuments on a type moderators cannot delete', file: SOCIAL_V10, expect: 'audit', node: '10900', mutate: (s) => { elected(s).moderatedDocumentTypes.follow = ['deleteDocuments']; } },
  { label: 'elected moderated type the contract does not have', file: SOCIAL_V10, expect: 'audit', node: '10900', mutate: (s) => { elected(s).moderatedDocumentTypes.nope = ['ban']; } },
  { label: 'elected changeDocumentFields on a type that lists no changeFields', file: SOCIAL_V10, expect: 'audit', node: '10900', mutate: (s) => { elected(s).moderatedDocumentTypes.post.push('changeDocumentFields'); } },
  { label: 'report changeFields without changeDocumentFields in the moderated set', file: SOCIAL_V10, expect: 'audit', node: '10900', mutate: (s) => { elected(s).moderatedDocumentTypes.report = ['deleteDocuments']; } },
  { label: 'elected seat contestable without challengeCoolDown', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { elected(s).seatContestable = true; } },
  { label: 'elected declaration without seatContestable', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { delete elected(s).seatContestable; } },
  { label: 'elected unknown ability', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { elected(s).moderatedDocumentTypes.post = ['nuke']; } },
  { label: 'config $formatVersion "1" drops moderation (moderatorAbilities then has no moderators)', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { s.config.$formatVersion = '1'; } },

  // moderatorAbilities (#5158). The removed keyword is the trap: the wasm-sdk drops it
  // without a word, so post would register with no moderator delete at all.
  { label: 'the removed canBeDeletedByModerators on post (silently dropped by the wasm-sdk)', file: SOCIAL_V10, expect: 'dpp2', node: '10101', mutate: (s) => { const p = types(s).post; delete p.moderatorAbilities; p.canBeDeletedByModerators = true; } },
  { label: 'changeFields naming the required report reason', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).report.moderatorAbilities.changeFields.push('reason'); } },
  { label: 'changeFields naming a property a where reads (targetOwnerId)', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { const r = types(s).report; r.moderatorAbilities.changeFields.push('targetOwnerId'); r.required = r.required.filter((p) => p !== 'targetOwnerId'); } },
  { label: 'changeFields on the indexOnly like', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).like.moderatorAbilities = { changeFields: ['hashtag'] }; } },
  { label: 'deleteKeepsRecord without delete', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).report.moderatorAbilities = { deleteKeepsRecord: false, changeFields: ['status', 'resolution'] }; } },
  { label: 'a [$moderatedBy, $moderatedAt] index on a type without changeFields', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).post.indices.push({ name: 'byModerator', properties: [{ $moderatedBy: 'asc' }, { $moderatedAt: 'asc' }] }); } },
  { label: 'moderatorAbilities.delete on a type with a contested index', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => {
    types(s).post.indices.push({ name: 'contestedProbe', unique: true, properties: [{ hashtag: 'asc' }], contested: { resolution: 0, fieldMatches: [{ field: 'hashtag', regexPattern: '^[a-z]{2}$' }], description: 'probe' } });
  } },

  // findBy / where (#5197).
  { label: 'the removed propertyAgreement on like.postId', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { const r = types(s).like.properties.postId.refersTo; delete r.where; r.propertyAgreement = { postAuthor: '$ownerId' }; } },
  { label: 'the removed lookup on privateFeedGrant.recipientId', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { const r = types(s).privateFeedGrant.properties.recipientId.refersTo; delete r.findBy; r.lookup = { index: 'targetAndRequester', keys: { targetId: '$ownerId', $ownerId: '.' } }; } },
  { label: 'findBy naming only part of a unique index', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).privateFeedGrant.properties.recipientId.refersTo.findBy = { $ownerId: '.' }; } },
  { label: 'yapprProfile ownerRefersTo findBy over a non-unique index (post byOwner)', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).yapprProfile.ownerRefersTo = { type: 'deletableDocument', documentType: 'post', findBy: { $ownerId: '.' } }; } },
  { label: 'grant findBy into followRequest whose targetId is not immutable', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { delete types(s).followRequest.immutable; } },
  { label: 'an immutable list holding the deletable followRequest findBy', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: 'registration', mutate: (s) => { const g = types(s).privateFeedGrant; g.documentsMutable = true; g.immutable = ['recipientId']; } },
  { label: 'permanentDocument owner gate at a deletable privateFeedState', file: SOCIAL_V10, expect: 'audit', node: '40122', mutate: (s) => { types(s).privateFeedState.canBeDeleted = true; } },
  { label: 'permanentDocument reference at the deletable post (bookmark)', file: SOCIAL_V10, expect: 'audit', node: '40122', mutate: (s) => { types(s).bookmark.properties.postId.refersTo.type = 'permanentDocument'; } },
  { label: 'D-25: the order storeStatus agreement against a property the store lacks', file: STOREFRONT, expect: 'audit', node: '40126', mutate: (s) => { types(s).storeOrder.properties.storeId.refersTo.where = { $ownerId: 'sellerId', state: 'storeStatus' }; } },

  // skipIfAbsent (#5162).
  { label: 'like without the all-time byHashtagPost (the "lean" variant)', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).like.indices = types(s).like.indices.filter((i) => i.name !== 'byHashtagPost'); } },
  { label: 'like.byHashtagPost without its own skipIfAbsent', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { delete types(s).like.indices.find((i) => i.name === 'byHashtagPost').skipIfAbsent; } },
  { label: 'skipIfAbsent on an index of required properties only', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).post.indices[0].skipIfAbsent = true; } },

  // Index shapes (V10-DESIGN §0): the wasm-sdk accepts every one; wasm-dpp2 and the audit refuse.
  { label: 'an index on a property the type does not have', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10209', mutate: (s) => { types(s).follow.indices.push({ name: 'probe', properties: [{ nope: 'asc' }] }); } },
  { label: 'an index on $id', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10208', mutate: (s) => { types(s).follow.indices.push({ name: 'probe', properties: [{ $id: 'asc' }] }); } },
  { label: 'an index on a typed array (hashtag arrays, V10-DESIGN §6)', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10206', mutate: (s) => { types(s).yapprProfile.indices.push({ name: 'probe', properties: [{ socialLinks: 'asc' }] }); } },
  { label: 'an indexed string of maxLength 64', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10205', mutate: (s) => { const p = types(s).post; p.properties.embedDocType.maxLength = 64; p.indices.push({ name: 'probe', properties: [{ embedDocType: 'asc' }] }); } },
  // Pads post to exactly 11 indexes whatever the cut declares (8 at the beta.7 re-cut).
  { label: 'an 11th index on post', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10101', mutate: (s) => {
    const { indices } = types(s).post;
    const spare = ['sensitive', 'keyGeneration', 'mediaUrl', 'embedDocType', 'nonce'];
    for (let n = 0; indices.length < 11; n++) indices.push({ name: `probe${n}`, properties: [{ [spare[n]]: 'asc' }] });
  } },

  // distinctFrom (#4917).
  { label: 'distinctFrom naming a property the type does not have', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).follow.properties.followingId.distinctFrom = 'nope'; } },
  { label: 'distinctFrom naming itself', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).follow.properties.followingId.distinctFrom = 'followingId'; } },
  { label: 'distinctFrom on a string property', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).block.properties.message.distinctFrom = '$ownerId'; } },
  { label: 'distinctFrom on a typed array instead of its items', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { const p = types(s).blockFollow.properties.followedBlockers; delete p.items.distinctFrom; p.distinctFrom = '$ownerId'; } },
  { label: 'storefront distinctFrom on a byte array that is not an identifier', file: STOREFRONT, expect: 'wasm', mutate: (s) => { types(s).storeOrder.properties.nonce.distinctFrom = '$ownerId'; } },

  // Typed arrays (#4922 #4923 #4928 #4924) and the size cap.
  { label: 'blockFollow typed array of 300 identity references (budget 256)', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: 'registration', mutate: (s) => { types(s).blockFollow.properties.followedBlockers.maxItems = 300; } },
  { label: 'typed array maxItems 1025', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: 'registration', mutate: (s) => { types(s).yapprProfile.properties.paymentUris.maxItems = 1025; } },
  { label: 'typed array without maxItems', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { delete types(s).yapprProfile.properties.paymentUris.maxItems; } },
  { label: 'typed string items with maxBytes below minLength', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).yapprProfile.properties.socialLinks.items.maxBytes = 2; } },
  { label: 'an unknown keyword on a property (meta-schema)', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10101', mutate: (s) => { types(s).follow.properties.followingId.distinctFromm = '$ownerId'; } },
  { label: 'content maxBytes above 65535', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).post.properties.content.maxBytes = 70_000; } },
  { label: 'v10 plus a 60-character description on every property (over the 20480-byte transition cap)', file: SOCIAL_V10, expect: 'audit', node: '10602 / rs-dapi size refusal', mutate: (s) => {
    for (const schema of Object.values(types(s))) for (const d of Object.values(schema.properties)) d.description = 'x'.repeat(60);
  } },

  // #4982/#4983 (beta.5) on a mutable storefront type; #4983 in the 5.0.0-beta.1 grammar.
  { label: 'a conditional immutable entry on a deletableDocument reference (#4983)', file: STOREFRONT, expect: 'dpp2', auditToo: true, node: 'registration', mutate: (s) => {
    const t = types(s).savedAddress;
    t.documentsMutable = true; t.immutable = [{ property: 'zoneId', when: { present: '$old.zoneId' } }];
    t.properties.zoneId = identifier(1, { type: 'deletableDocument', documentType: 'shippingZone' });
  } },
  { label: 'immutable contract reference with an owner requirement on a transferable type (#4982)', file: STOREFRONT, expect: 'dpp2', auditToo: true, node: 'registration', mutate: (s) => {
    const t = types(s).savedAddress;
    t.transferable = 1; t.documentsMutable = true; t.immutable = ['appContractId'];
    t.properties.appContractId = identifier(1, { type: 'contract', contractRequirements: { owner: 'self' } });
  } },
  { label: 'immutable object holding a by-id deletableDocument reference (nested path)', file: STOREFRONT, expect: 'dpp2', auditToo: true, node: 'registration', mutate: (s) => {
    const t = types(s).savedAddress;
    t.documentsMutable = true; t.immutable = ['link'];
    t.properties.link = { type: 'object', position: 1, additionalProperties: false, properties: { storeId: identifier(0, { type: 'deletableDocument', documentType: 'shippingZone' }) } };
  } },
  // rs-dpp `lists_as_immutable`: a property listed with a condition counts as immutable too.
  { label: 'the same object under a conditional immutable entry', file: STOREFRONT, expect: 'dpp2', auditToo: true, node: 'registration', mutate: (s) => {
    const t = types(s).savedAddress;
    t.documentsMutable = true; t.immutable = [{ property: 'link', when: { present: '$old.link' } }];
    t.properties.link = { type: 'object', position: 1, additionalProperties: false, properties: { storeId: identifier(0, { type: 'deletableDocument', documentType: 'shippingZone' }) } };
  } },

  // Document TTL (#5007).
  { label: 'ttl of one day on savedAddress (control)', file: STOREFRONT, expect: 'accepted', mutate: (s) => { types(s).savedAddress.ttl = 86_400; } },
  { label: 'ttl on a type without $createdAt in required', file: STOREFRONT, expect: 'wasm', mutate: (s) => { const t = types(s).savedAddress; t.ttl = 86_400; t.required = t.required.filter((p) => p !== '$createdAt'); } },
  { label: 'ttl on an indexOnly type', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).like.ttl = 86_400; } },
  { label: 'ttl of 60 s (under the one-hour floor)', file: STOREFRONT, expect: 'wasm', mutate: (s) => { types(s).savedAddress.ttl = 60; } },
  { label: 'ttl on the target of a permanentDocument owner gate (privateFeedState)', file: SOCIAL_V10, expect: 'audit', node: '40122', mutate: (s) => { types(s).privateFeedState.ttl = 86_400; } },
  { label: 'report ttl without $createdAt in required', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { const t = types(s).report; t.required = t.required.filter((p) => p !== '$createdAt'); } },
  { label: 'report ttl over one year', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).report.ttl = 31_536_001; } },

  // propertyConstraints grammar (#5036-#5042) and the rules the cuts declare.
  { label: 'propertyConstraints enum const + absent (control)', file: STOREFRONT, expect: 'accepted', mutate: (s) => { types(s).storeItem.propertyConstraints = { soldOutHasNoStock: { anyOf: [{ notEqual: ['status', { const: 'sold_out' }] }, { absent: 'stockQuantity' }, { equal: ['stockQuantity', 0] }] } }; } },
  { label: 'propertyConstraints const outside the enum', file: STOREFRONT, expect: 'wasm', mutate: (s) => { types(s).storeItem.propertyConstraints = { r: { equal: ['status', { const: 'gone' }] } }; } },
  { label: 'storeIsOpen comparing storeStatus with a value outside its enum', file: STOREFRONT, expect: 'wasm', mutate: (s) => { types(s).storeOrder.propertyConstraints.storeIsOpen = { equal: ['storeStatus', { const: 'open' }] }; } },
  { label: 'propertyConstraints anyOf directly inside anyOf', file: STOREFRONT, expect: 'wasm', mutate: (s) => { types(s).storeItem.propertyConstraints = { r: { anyOf: [{ anyOf: [{ equal: ['weight', 0] }, { equal: ['weight', 1] }] }, { equal: ['weight', 2] }] } }; } },
  { label: 'tieredHasTiers comparing rateType with a value outside its enum', file: STOREFRONT, expect: 'wasm', mutate: (s) => { types(s).shippingZone.propertyConstraints.tieredHasTiers.anyOf[0] = { equal: ['rateType', { const: 'flat_rate' }] }; } },
  { label: 'resolvedHasStatus reading a property report does not have', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).report.propertyConstraints.resolvedHasStatus.anyOf[1] = { present: 'state' }; } },
  { label: 'privateAllOrNone reading a string property as an integer operand', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).post.propertyConstraints.privateAllOrNone = { greaterThan: ['content', 0] }; } },
  { label: 'a 17th propertyConstraints rule on post (16 max)', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => {
    const rules = types(s).post.propertyConstraints;
    for (let n = 0; Object.keys(rules).length < 17; n++) rules[`extra${n}`] = { absent: 'content' };
  } },
  // rs-dpp node_count: allOf 1 + each `anyOf [absent, present]` 3; 22 as cut, so 4 more make 34.
  { label: 'a 34-node optionsContiguous rule (32 max)', file: 'contracts/pollr-contract.json', expect: 'wasm', mutate: (s) => {
    const rule = types(s).poll.propertyConstraints.optionsContiguous.allOf;
    for (const property of ['question', 'option0', 'option1', 'multiChoice']) rule.push({ anyOf: [{ absent: 'endsAt' }, { present: property }] });
  } },
];

/**
 * The `where` agreements of the reply and report references, judged off the
 * PARSED contract (`documentTypeReferences`), so a declaration the parser
 * dropped fails here. No package checks a `where` offline: consensus fetches
 * the referenced document and refuses a disagreement with 40127. This models
 * that equality on hand-written documents (owners as names), so each case pins
 * what the cut binds; `verify-v10.mjs` broadcasts the refused ones.
 * [label, file, referring type, reference path, the referring document's
 * values, the referenced document's values, '40127' or null for agreement]
 */
const WHERE_CASES = [
  ['v13: a top-level reply naming its root post\'s owner', SOCIAL_V13, 'reply', 'rootPostId', { rootOwnerId: 'alice' }, { $ownerId: 'alice' }, null],
  // With parentIsRoot (parentOwnerId = rootOwnerId on a top-level reply), this closes the
  // forged "replied to you": the notification index keys on parentOwnerId.
  ['v13: reply forgery, a rootOwnerId that does not own the root post', SOCIAL_V13, 'reply', 'rootPostId', { rootOwnerId: 'mallory' }, { $ownerId: 'alice' }, '40127'],
  ['v13: a nested reply in its parent\'s thread', SOCIAL_V13, 'reply', 'replyToReplyId', { parentOwnerId: 'bob', rootPostId: 'thread1' }, { $ownerId: 'bob', rootPostId: 'thread1' }, null],
  ['v13: a nested reply crossing threads (its parent is in another thread)', SOCIAL_V13, 'reply', 'replyToReplyId', { parentOwnerId: 'bob', rootPostId: 'thread1' }, { $ownerId: 'bob', rootPostId: 'thread2' }, '40127'],
  ['v13: a nested reply naming someone else as its parent\'s owner', SOCIAL_V13, 'reply', 'replyToReplyId', { parentOwnerId: 'carol', rootPostId: 'thread1' }, { $ownerId: 'bob', rootPostId: 'thread1' }, '40127'],
  // The holes v13 closes, still open on v12.
  ['v12 (the hole): a top-level reply binds no owner to its root post', SOCIAL_V12, 'reply', 'rootPostId', { parentOwnerId: 'mallory' }, { $ownerId: 'alice' }, null],
  ['v12 (the hole): a nested reply crossing threads agrees', SOCIAL_V12, 'reply', 'replyToReplyId', { parentOwnerId: 'bob', rootPostId: 'thread1' }, { $ownerId: 'bob', rootPostId: 'thread2' }, null],
  ['v13: a post report naming the post\'s author', SOCIAL_V13, 'report', 'postId', { targetOwnerId: 'alice' }, { $ownerId: 'alice' }, null],
  ['v13: a post report naming someone else as the author', SOCIAL_V13, 'report', 'postId', { targetOwnerId: 'bob' }, { $ownerId: 'alice' }, '40127'],
  ['v13: a reply report naming someone else as the author', SOCIAL_V13, 'report', 'replyId', { targetOwnerId: 'bob' }, { $ownerId: 'alice' }, '40127'],
];

function runWhereCases({ loadContractSource, parseContract }) {
  let failures = 0;
  const parsed = new Map();
  console.log('\nreference `where` agreements (read off the parsed contract; the node refuses a disagreement with 40127):');
  for (const [label, file, type, path, referring, referenced, expected] of WHERE_CASES) {
    if (!parsed.has(file)) parsed.set(file, parseContract(loadContractSource(file)));
    const reference = parsed.get(file).documentTypeReferences(type).find((r) => r.path === path);
    // A value left out on both sides agrees, as consensus judges it.
    const disagreement = Object.entries(reference?.where ?? {}).find(([theirs, mine]) => referring[mine] !== referenced[theirs]);
    const outcome = reference && disagreement ? '40127' : null;
    const ok = reference !== undefined && outcome === expected;
    if (!ok) failures += 1;
    const detail = disagreement ? `${type}.${path} where ${disagreement[0]} = ${disagreement[1]}: ${referenced[disagreement[0]]} ≠ ${referring[disagreement[1]]}` : `where ${JSON.stringify(reference?.where ?? null)} agrees`;
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${(outcome ?? 'agrees').padEnd(8)}] ${label} — ${detail}${ok ? '' : ` (expected ${expected ?? 'agreement'})`}`);
  }
  return failures;
}

/**
 * Runs every probe and `where` case; returns the number whose outcome differs
 * from the recorded one. `parseContract` is the wasm-sdk parse,
 * `parseWithNodeRules` the wasm-dpp2 one.
 */
export function runContractProbes({ loadContractSource, parseContract, parseWithNodeRules, sizeOf, updateRefusals }) {
  let failures = 0;
  console.log('\nnegative probes (wasm = refused by the wasm-sdk parse; dpp2 = only by the wasm-dpp2 parse; audit = both parse, the node refuses; update = version 2 parses, the update rules refuse it):');
  for (const probe of PROBES) {
    // As the probe's network registers the file (mainnet: an elected interim becomes notYetUsable).
    const stored = loadContractSource(probe.file, { network: probe.network });
    const source = structuredClone(stored);
    if (probe.update) {
      source.version = (stored.version ?? 1) + 1;
      probe.update(source);
    } else {
      probe.mutate(source);
    }
    const refusal = (parse) => { try { parse(source); return null; } catch (e) { return String(e?.message ?? e); } };
    const wasmError = refusal(parseContract);
    const dpp2Error = wasmError ? null : refusal(parseWithNodeRules);
    const audit = [];
    if (!wasmError) {
      audit.push(...auditNodeRules(source, { network: probe.network ?? 'devnet' }), ...metaSchemaProblems(source));
      const size = sizeOf(parseContract(source));
      if (size.overCap) audit.push(`create transition ~${size.bytes} B, over the ${STATE_TRANSITION_CAP} B cap`);
    }
    const updateErrors = probe.update && !wasmError && !dpp2Error ? updateRefusals(stored, source) : [];
    const outcome = wasmError ? 'wasm' : dpp2Error ? 'dpp2' : audit.length > 0 ? 'audit' : updateErrors.length > 0 ? 'update' : 'accepted';
    const auditMissed = probe.auditToo && audit.length === 0;
    const detail = wasmError ?? dpp2Error ?? audit[0] ?? updateErrors[0] ?? '';
    // A refusal for some other reason than the probed rule is no proof of that rule.
    const wrongReason = probe.why !== undefined && outcome !== 'accepted' && !probe.why.test(detail);
    // An update refusal reads "<code> <message>": it must be the code the node refuses with.
    const wrongCode = outcome === 'update' && probe.node !== undefined && !detail.startsWith(`${probe.node} `);
    const statementFails = probe.holds !== undefined && !probe.holds(source, wasmError ? null : parseContract(source));
    const ok = outcome === probe.expect && !auditMissed && !wrongReason && !wrongCode && !statementFails;
    if (!ok) failures += 1;
    const where = outcome === 'audit' || outcome === 'dpp2' || outcome === 'update' ? ` (node: ${probe.node ?? '?'}; the SDK signs it)` : '';
    const note = `${auditMissed ? ' (auditNodeRules did not flag it)' : ''}${wrongReason ? ` (refused, but not for ${probe.why})` : ''}${wrongCode ? ` (refused, but not with ${probe.node})` : ''}${statementFails ? ' (its `holds` statement is false)' : ''}`;
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${outcome.padEnd(8)}] ${probe.label}${where}${detail ? ` — ${detail.replace(/\s+/g, ' ').slice(0, 150)}` : ''}${note}${outcome === probe.expect ? '' : ` (expected ${probe.expect})`}`);
  }
  return failures + runWhereCases({ loadContractSource, parseContract });
}
