/**
 * The registration rules the local parses do NOT run, re-checked offline,
 * and the negative probes that record which refusals are local and which only
 * a node makes. Used by `validate-contract-offline.mjs`.
 *
 * Three layers, measured on 4.2.0-beta.7 and re-run on 5.0.0-beta.1,
 * 5.0.0-beta.2, 5.0.0-beta.3, 5.0.0-beta.4 and 5.0.0-beta.5 with `DataContract.fromJSON(json, true, latest)`
 * (and a fourth for contract updates, below):
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
 *     cap, that both sides of every same-contract `where` entry exist
 *     (40126), and the non-transferable token rules of 5.0.0-beta.4 (10279,
 *     10280; `auditNonTransferableTokens`). It also re-checks the index
 *     shapes wasm-dpp2 checks (`auditIndexShapes`, ported from the v10 study's
 *     index-audit.py), so the rules Yappr relies on do not depend on one
 *     package alone. Property type shorthands are judged in long form
 *     (`scripts/schema-shorthands.mjs`), as the node expands them first.
 *   - **update** (an `update` probe): version 2 of a committed cut parses
 *     under both, and wasm-dpp2's `DataContract.validateUpdate` (the code a
 *     data contract update transition runs, no state read) refuses it.
 *
 * The 5.0.0-beta.2 keywords (`summableOffCountIndex`, `retractedWhen`,
 * `deleteSettled.approversPredateDocument`) are all refused by the wasm-sdk
 * parse itself (10231): the structural rules run with full validation there.
 *
 * Rule budgets are not re-counted here: both parses refuse a type with more
 * than 16 propertyConstraints rules or a rule above 32 nodes (the probes
 * below record it at the `wasm` layer). 5.0.0-beta.3 adds two things to that
 * budget: a `countPresent` operand costs 1 node plus 1 per path it tests, and
 * a type's `deleteConstraints` (rules its owner's delete must meet, refused
 * with 40147) have their own 16 × 32 budget and 4 distinct totals, counted
 * apart from `propertyConstraints`.
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
import { expandSchemas, expandShorthands } from './schema-shorthands.mjs';
;

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
/** The [min, max] seconds an elected declaration's joinWindow and voteWindow may take on `network`. */
export function electionWindowBounds(network) {
  return network === 'mainnet' ? [LIMITS.mainnetElectionWindowFloor, LIMITS.electionWindow[1]] : LIMITS.electionWindow;
}
const SIGNATURE_ALLOWANCE = 100;

// ---- JSON meta-schema --------------------------------------------------------

/**
 * rs-dpp's document meta-schema v3 at v5.0.0-beta.6 (beta.6 added the
 * `contains` and `containsAll` conditions of a refersTo `where` on a typed
 * array, and describes an equality of two typed arrays as one of lists;
 * beta.5 added the `referenced` propertyConstraints operand, the `$old.` prefix and `$revision`
 * in propertyConstraints rules, the `referenceWhereCondition` forms of a
 * refersTo `where`, the `$ownerId` param of a sys.hash `findBy`, and `constraints`
 * (`minimumAgeBlocks`, `chooseFirst`) beside `findBy`; beta.4 added the
 * `byteAt` operand, hex byte-array operands for `startsWith`/`endsWith`, and
 * the note that the `identifier`/`bytes` property shorthands are expanded
 * before it runs; beta.3 added the `countPresent` operand, `deleteConstraints`
 * and `$id` as a countOf/sumOf filter value; beta.2 added
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
 * ajv pass names the failing path more precisely. The property type shorthands
 * never reach it: the node expands them first, and so does `metaSchemaProblems`.
 */
const META_SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'meta-schema', 'document-meta-v3.json');
const META_SCHEMA_SHA256 = '742f99130f75940a3ba2962f243713fb745be0689093cd48d496f5026afc0d15';

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
  if (digest !== META_SCHEMA_SHA256) throw new Error(`${META_SCHEMA_PATH} is not the pinned v5.0.0-beta.6 meta-schema (sha256 ${digest})`);
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
    // The node expands the property type shorthands before its meta-schema runs.
    const enriched = expandShorthands({ $schema: meta.id, ...schema, ...(source.$defs ? { $defs: source.$defs } : {}) });
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
  const bounds = electionWindowBounds(network);
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

/** The property names an index lists, in order. */
const indexPropertyNames = (index) => index.properties.map((entry) => Object.keys(entry)[0]);

/** Whether a property definition is a typed array (not a byte array). */
const isTypedArray = (definition) => definition?.type === 'array' && definition.byteArray !== true && definition.items !== undefined;

/** The typed array property `index` names, or undefined. */
const typedArrayOf = (schema, index) => indexPropertyNames(index).find((property) => isTypedArray(schema.properties?.[property]));

const MAX_INDEXED_TYPED_ARRAY_ITEMS = 16;
const MAX_INDEXED_WINDOWED_TYPED_ARRAY_ITEMS = 4;
const MAX_INDEX_ENTRIES_PER_DOCUMENT = 256;

/**
 * 5.0.0-beta.5 (#5370, book contract-keywords/indexes.md "Typed arrays"): an
 * index may name one top-level typed array and enters the document once per
 * distinct element. The element is held to the key limits of its type, the
 * array to 16 items (4 under a timeRange or integerRange window), and the
 * index may not be unique or contested, turn off nullSearchable, or skip on
 * the array alone (it skips a document without elements already).
 */
function typedArrayIndexProblems(name, schema, index, property, definition) {
  const at = `${name}.${index.name}`;
  const problems = [];
  if (property.includes('.')) problems.push(`${at}: the typed array "${property}" is not a top-level property (10231)`);
  const arrays = indexPropertyNames(index).filter((p) => isTypedArray(schema.properties?.[p]));
  if (arrays.length > 1 && arrays[0] === property) problems.push(`${at}: names ${arrays.length} typed arrays (${arrays.join(', ')}); an index keys by the elements of one (10231)`);
  const windowed = index.timeRange !== undefined || index.integerRange !== undefined;
  const cap = windowed ? MAX_INDEXED_WINDOWED_TYPED_ARRAY_ITEMS : MAX_INDEXED_TYPED_ARRAY_ITEMS;
  if (!(definition.maxItems <= cap)) problems.push(`${at}: indexed typed array "${property}" has maxItems ${definition.maxItems}, above ${cap}${windowed ? ' under a window' : ''} (10205)`);
  const items = definition.items;
  if (items.type === 'string' && !(items.maxLength <= MAX_INDEXED_STRING_LENGTH)) problems.push(`${at}: the elements of "${property}" have maxLength ${items.maxLength ?? 'unbounded'}, above ${MAX_INDEXED_STRING_LENGTH} (10205)`);
  if (items.type === 'array' && items.byteArray === true && !(items.maxItems <= MAX_INDEXED_BYTE_ARRAY_LENGTH && items.minItems >= 1)) {
    problems.push(`${at}: the byte array elements of "${property}" must hold 1 to ${MAX_INDEXED_BYTE_ARRAY_LENGTH} bytes (10205)`);
  }
  if (index.unique === true || index.contested) problems.push(`${at}: a unique or contested index cannot name the typed array "${property}" (10231)`);
  if (index.nullSearchable === false) problems.push(`${at}: an index naming a typed array keeps nullSearchable (10231)`);
  const skip = index.skipIfAbsent === true
    ? indexPropertyNames(index).filter((p) => !p.startsWith('$') && !(schema.required ?? []).includes(p))
    : Array.isArray(index.skipIfAbsent) ? index.skipIfAbsent : [];
  if (skip.length === 1 && skip[0] === property) problems.push(`${at}: skipIfAbsent would skip on the typed array "${property}" alone, which an element index does already (10231)`);
  return problems;
}

/** An index's whole key: its properties, then its terminal (a property name or a list of them). */
const indexKey = (index) => [...indexPropertyNames(index), ...[index.terminal ?? []].flat()];

/**
 * Whether a `where` equality of a `permanentDocument` or `moderatedDocument`
 * reference of `schema` makes its typed array `property` equal to a typed
 * array of the referenced document (`"tags": "tags"`), which fixes every
 * element of the list to the referenced document's.
 */
function arrayFixedByWhere(schemas, schema, property) {
  return Object.values(schema.properties ?? {}).some((definition) => {
    const ref = definition.refersTo;
    if (!ref || ref.contractId || !['permanentDocument', 'moderatedDocument'].includes(ref.type)) return false;
    return Object.entries(ref.where ?? {}).some(([referenced, referring]) => referring === property && isTypedArray(propertyAt(schemas[ref.documentType] ?? {}, referenced)));
  });
}

/**
 * 5.0.0-beta.6 (#5390, #5394; book contract-keywords/index-only.md "Typed
 * arrays" and "Counting per element"): on an indexOnly type an index naming a
 * typed array is no uniqueness rule of its own, so the array declares
 * `uniqueItems`; unless the index keeps counters (`summableOffCountIndex`),
 * another index that keeps one entry per document (no `$createdAt`, no skip,
 * not outliving deletes, entries, no typed array) has its whole key inside
 * this one's key without the array; it is `preallocated` or a counter only
 * when a `where` equality makes the array equal to a typed array of the
 * referenced document; and no counter counts it as its source. 5.0.0-beta.5
 * refuses every typed-array index on an indexOnly type (10231).
 */
function indexOnlyTypedArrayProblems(schemas, name, schema, index, property) {
  const at = `${name}.${index.name}`;
  const problems = [];
  if (schema.properties[property].uniqueItems !== true) problems.push(`${at}: the typed array "${property}" of an indexOnly type's index must declare uniqueItems (10231)`);
  const key = new Set(indexKey(index).filter((p) => p !== property));
  const keepsEveryDocument = (other) => other !== index && !indexPropertyNames(other).includes('$createdAt') && !other.skipIfAbsent
    && !other.outlivesDelete && !other.summableOffCountIndex && !typedArrayOf(schema, other);
  if (!index.summableOffCountIndex && !(schema.indices ?? []).some((other) => keepsEveryDocument(other) && indexKey(other).every((p) => key.has(p)))) {
    problems.push(`${at}: no index keeping one entry per document has its whole key inside this index's key without "${property}" (10231)`);
  }
  if ((index.preallocated || index.summableOffCountIndex) && !arrayFixedByWhere(schemas, schema, property)) {
    problems.push(`${at}: preallocated or a summableOffCountIndex over "${property}" needs a where equality making it a typed array of the referenced document (10231)`);
  }
  if ((schema.indices ?? []).some((other) => other.summableOffCountIndex === index.name)) problems.push(`${at}: a summableOffCountIndex index counts this typed-array index as its source (10231)`);
  return problems;
}

/** One document's index entries on a type with an indexed typed array: each index 1, times its array's maxItems (windows not modelled). */
function typedArrayEntryBudget(name, schema) {
  const arrays = (schema.indices ?? []).map((index) => typedArrayOf(schema, index));
  if (!arrays.some(Boolean)) return [];
  const entries = arrays.reduce((total, array) => total + (array ? schema.properties[array].maxItems : 1), 0);
  return entries > MAX_INDEX_ENTRIES_PER_DOCUMENT ? [`${name}: a document writes up to ${entries} index entries, above ${MAX_INDEX_ENTRIES_PER_DOCUMENT} (10231)`] : [];
}

/**
 * The index shape rules (V10-DESIGN §0, ported from index-audit.py): every
 * property exists or is a system property other than `$id`; none is an
 * object or a plain array (10206), and a typed array only as 5.0.0-beta.5
 * allows (`typedArrayIndexProblems`), on an indexOnly type as 5.0.0-beta.6
 * allows (`indexOnlyTypedArrayProblems`); indexed strings are at most 63
 * characters and byte arrays at most 255 bytes (10205); at most 10 indexes
 * with distinct names. wasm-dpp2 refuses the same shapes (5.0.0-beta.4's
 * refuses every typed-array index, 10206); the wasm-sdk parse accepts them.
 */
function auditIndexShapes(schemas) {
  const problems = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const indices = schema.indices ?? [];
    problems.push(...typedArrayEntryBudget(name, schema));
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
        if (isTypedArray(definition)) {
          problems.push(...typedArrayIndexProblems(name, schema, index, property, definition));
          if (schema.indexOnly === true) problems.push(...indexOnlyTypedArrayProblems(schemas, name, schema, index, property));
        } else if (definition.type === 'object' || (definition.type === 'array' && definition.byteArray !== true)) {
          problems.push(`${name}.${index.name}: "${property}" is an ${definition.type} and cannot be indexed (10206)`);
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
  // Judged in long form, as the node judges them once it expanded the shorthands.
  const schemas = expandSchemas(source.documentSchemas);
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
      // `where` entry must exist and hold the same type of value. 5.0.0-beta.6
      // (#5388): a typed array pairs only with a typed array of the same element
      // kind (never floats), and the two are equal as lists.
      for (const [referenced, referring] of Object.entries(ref.where ?? {})) {
        if (typeof referring !== 'string') {
          problems.push(...whereConditionProblems(`${name}.${path}`, referenced, referring, { schema, target, targetName: ref.documentType }));
          continue;
        }
        const theirs = referenced.startsWith('$') ? { system: referenced } : propertyAt(target, referenced);
        const mine = referring.startsWith('$') ? { system: referring } : propertyAt(schema, referring);
        if (!theirs) problems.push(`${name}.${path}: where names "${referenced}", which "${ref.documentType}" does not have (40126)`);
        if (!mine) problems.push(`${name}.${path}: where reads "${referring}", which "${name}" does not have (40126)`);
        if (!theirs?.type || !mine?.type) continue;
        if (isTypedArray(theirs) !== isTypedArray(mine)) {
          problems.push(`${name}.${path}: where pairs "${referenced}" (${valueKind(theirs)}) with "${referring}" (${valueKind(mine)}); a typed array pairs only with a typed array (40126)`);
        } else if (isTypedArray(theirs)) {
          if (valueKind(theirs) !== valueKind(mine) || theirs.items.type === 'number') {
            problems.push(`${name}.${path}: where compares the lists "${referenced}" (${valueKind(theirs)}) and "${referring}" (${valueKind(mine)}), whose elements must share one kind that is not a float (40126)`);
          }
        } else if (theirs.type !== mine.type || (theirs.byteArray === true) !== (mine.byteArray === true)) {
          problems.push(`${name}.${path}: where compares "${referenced}" (${valueKind(theirs)}) with "${referring}" (${valueKind(mine)}) (40126)`);
        }
      }
      const mismatch = referenceKindMismatch(ref.type, target, config);
      if (mismatch) problems.push(`${name}.${path}: "${ref.documentType}" ${mismatch}`);
    }
  }
  problems.push(...auditNonTransferableTokens(source));
  return problems;
}

/** A value's kind for the `where` rules: a typed array is `list of <element kind>`, a byte array `bytes`. */
function valueKind(definition) {
  if (definition?.system) return 'identifier';
  if (isTypedArray(definition)) return `list of ${valueKind(definition.items)}`;
  if (definition?.byteArray === true) return definition.contentMediaType === 'application/x.dash.dpp.identifier' ? 'identifier' : 'bytes';
  return definition?.type ?? 'unknown';
}

const SYSTEM_TIMES = /^\$(created|updated|transferred)At(BlockHeight|CoreBlockHeight)?$/;
const ORDERINGS = ['greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'];

/** Whether `literal` is a value `definition` can hold (its JSON type and enum). */
function literalFits(literal, definition) {
  if (definition.enum && !definition.enum.includes(literal)) return false;
  if (definition.type === 'integer') return Number.isInteger(literal);
  if (definition.type === 'boolean') return typeof literal === 'boolean';
  return typeof literal === 'string';
}

/**
 * The 5.0.0-beta.5 `where` conditions (#5369, book refers-to.md "Conditions"),
 * registration rules a node refuses with 40126: the referenced side holds one
 * value (not an object or a typed array); a `const` or `in` literal is a value
 * it can hold; a `notEqual` bound is `$ownerId`, a `{ const }` or a property of
 * the declaring type of the same kind; an ordering compares integers, bounded
 * by an integer property, an integer `{ const }` or a time or height the
 * declaring type lists in `required`.
 */
function whereConditionProblems(at, referenced, condition, { schema, target, targetName }) {
  const problems = [];
  const keys = Object.keys(condition ?? {});
  if (keys.length !== 1) return [`${at}: where ${referenced} is not a one-key condition (10101)`];
  const [kind] = keys;
  const value = condition[kind];
  const theirs = referenced.startsWith('$') ? { type: 'identifier' } : propertyAt(target, referenced);
  if (!theirs) return [`${at}: where names "${referenced}", which "${targetName}" does not have (40126)`];
  const refuse = (why) => problems.push(`${at}: where ${referenced} ${JSON.stringify(condition)}: ${why} (40126)`);
  // 5.0.0-beta.6 (#5388): `contains` (a referring value or the writer it must hold) and
  // `containsAll` (a referring typed array whose every element it must hold), of a typed array.
  if (kind === 'contains' || kind === 'containsAll') {
    if (!isTypedArray(theirs)) return [`${at}: where ${referenced} ${kind}: "${referenced}" is not a typed array (40126)`];
    const elements = valueKind(theirs.items);
    if (theirs.items.type === 'number') refuse('its elements are floats');
    if (kind === 'contains' && value === '$ownerId') {
      if (elements !== 'identifier') refuse('"$ownerId" is held only among identifier elements');
    } else {
      const mine = typeof value === 'string' ? propertyAt(schema, value) : undefined;
      const wanted = kind === 'contains' ? elements : `list of ${elements}`;
      if (!mine) refuse(`the declaring type has no "${value}"`);
      else if (valueKind(mine) !== wanted) refuse(`"${value}" (${valueKind(mine)}) is not a ${wanted}`);
    }
    return problems;
  }
  if (theirs.type === 'object' || (theirs.type === 'array' && theirs.byteArray !== true)) return [`${at}: where condition on "${referenced}", which holds no single value (40126)`];
  const requireFit = (literal) => {
    if (!literalFits(literal, theirs)) refuse(`${JSON.stringify(literal)} is not a value "${referenced}" can hold`);
  };
  if (kind === 'const') {
    requireFit(value);
  } else if (kind === 'in') {
    if (!Array.isArray(value) || value.length < 2 || value.length > 30 || new Set(value).size !== value.length) refuse('an `in` lists 2 to 30 distinct literals');
    else value.forEach(requireFit);
  } else if (kind === 'notEqual') {
    if (value && typeof value === 'object') {
      requireFit(value.const);
    } else if (value !== '$ownerId') {
      const mine = propertyAt(schema, value);
      if (!mine) refuse(`the declaring type has no "${value}"`);
      else if (mine.type !== theirs.type) refuse(`"${value}" (${mine.type}) is not of the kind of "${referenced}" (${theirs.type})`);
    }
  } else if (ORDERINGS.includes(kind)) {
    if (theirs.type !== 'integer') refuse(`"${referenced}" is not an integer`);
    if (value && typeof value === 'object') {
      if (!Number.isInteger(value.const)) refuse('the bound is not an integer');
    } else if (SYSTEM_TIMES.test(value)) {
      if (!(schema.required ?? []).includes(value)) refuse(`the declaring type does not list ${value} in required`);
    } else if (propertyAt(schema, value)?.type !== 'integer') {
      refuse(`the bound "${value}" is not an integer property of the declaring type`);
    }
  } else {
    refuse(`unknown condition "${kind}"`);
  }
  return problems;
}

/**
 * The 5.0.0-beta.4 registration rules for a token declared `transferable:
 * false`: a document `tokenCost` in it must burn (`effect: 1`; the default, 0,
 * pays the contract owner), 10280; and it may not have its own shielded pool,
 * 10279. A transfer of it (refused by the mempool), and the registration of
 * another contract charging it, are 40726: state checks no offline audit of
 * one contract can make.
 */
function auditNonTransferableTokens(source) {
  const problems = [];
  const tokens = source.tokens ?? {};
  for (const [position, token] of Object.entries(tokens)) {
    if (token.transferable === false && token.hasShieldedPool === true) problems.push(`token ${position} is not transferable and has a shielded pool (10279)`);
  }
  for (const [name, schema] of Object.entries(source.documentSchemas)) {
    for (const [action, cost] of Object.entries(schema.tokenCost ?? {})) {
      if (cost.contractId !== undefined || tokens[cost.tokenPosition]?.transferable !== false) continue;
      if ((cost.effect ?? 0) !== 1) problems.push(`${name}: the ${action} token cost pays the contract owner in the non-transferable token ${cost.tokenPosition}, it must burn it (effect 1, 10280)`);
    }
  }
  return problems;
}

// ---- Negative probes ---------------------------------------------------------

const SOCIAL_V10 = 'contracts/yappr-social-contract-v10.json';
const SOCIAL_V11 = 'contracts/yappr-social-contract-v11.json';
const SOCIAL_V12 = 'contracts/yappr-social-contract-v12.json';
const SOCIAL_V13 = 'contracts/yappr-social-contract-v13.json';
const SOCIAL_V14 = 'contracts/yappr-social-contract-v14.json';
const SOCIAL_V15 = 'contracts/yappr-social-contract-v15.json';
const SOCIAL_V16 = 'contracts/yappr-social-contract-v16.json';
const BLOCKS = 'contracts/yappr-blocks-contract.json';
const SOCIAL_V9 = 'contracts/yappr-social-contract-v9.json';
const STOREFRONT = 'contracts/yappr-storefront-contract.json';
const PROFILE = 'contracts/yappr-profile-contract.json';
const BLOG = 'contracts/yappr-blog-contract.json';
const APP_ANCHOR = 'contracts/yappr-app-contract.json';
const POLLR = 'contracts/pollr-contract.json';

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
const identifier = (position, refersTo) => ({ type: 'identifier', position, ...(refersTo ? { refersTo } : {}) });
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
  { label: 'control: pollr as committed', file: POLLR, mutate: () => {}, expect: 'accepted' },
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

  // Social v14 (5.0.0-beta.3, docs/SOCIAL_V14.md): countPresent rules, the report deleteConstraints,
  // the derived reply-owner windows and an unpaused YAPP. Every refusal below was first measured
  // with rs-dpp at the v5.0.0-beta.3 tag; `why` pins the rule that speaks.
  { label: 'control: social v14 as committed (devnet: interim contractOwner)', file: SOCIAL_V14, mutate: () => {}, expect: 'accepted', holds: (s) => elected(s).interim.$type === 'contractOwner' },
  { label: 'control: social v14 as mainnet registers it (interim notYetUsable)', file: SOCIAL_V14, network: 'mainnet', mutate: () => {}, expect: 'accepted', holds: (s) => elected(s).interim.$type === 'notYetUsable' },
  // beta.3 refuses a tokenCost paid in a paused token (40711), so v14's YAPP starts unpaused, and
  // with `emergencyActionRules: noOne` nobody can ever pause it. Everything else is v13's.
  { label: 'v14: YAPP starts unpaused, can never be paused, and still has no price', file: SOCIAL_V14, mutate: () => {}, expect: 'accepted', holds: (s) => {
    const yapp = s.tokens['0'];
    return yapp.startAsPaused === false && yapp.emergencyActionRules.authorizedToMakeChange.$type === 'noOne'
      && yapp.distributionRules.changeDirectPurchasePricingRules.authorizedToMakeChange.$type === 'noOne';
  } },
  // Read back off the PARSED contract, so a keyword the parser dropped fails here.
  { label: 'v14: the parsed reply files its windows under the derived owners, and stores no owner', file: SOCIAL_V14, mutate: () => {}, expect: 'accepted', holds: (_s, parsed) => {
    const reply = parsed.schemas.reply;
    const window = (name) => reply?.indices?.find((i) => i.name === name);
    const keys = (index) => index?.properties?.map((p) => Object.keys(p)[0]);
    return JSON.stringify(keys(window('rootOwnerRecent'))) === '["$createdAt","rootPostId.$ownerId"]'
      && JSON.stringify(keys(window('parentOwnerRecent'))) === '["$createdAt","replyToReplyId.$ownerId"]'
      && JSON.stringify(window('parentOwnerRecent')?.skipIfAbsent) === '["replyToReplyId.$ownerId"]'
      && window('rootOwnerRecent')?.skipIfAbsent === undefined
      && !reply.properties.parentOwnerId && !reply.properties.rootOwnerId;
  } },
  { label: 'v14: the parsed report keeps its deleteConstraints (withdrawal only while pending)', file: SOCIAL_V14, mutate: () => {}, expect: 'accepted', holds: (_s, parsed) => JSON.stringify(parsed.schemas.report?.deleteConstraints) === '{"pending":{"absent":"status"}}' },
  // A derived property reads through a reference the type fixes for good: frozen with a condition
  // (a tombstone could re-point it) is refused, which is why no quote-owner window exists.
  { label: 'v14: replyToReplyId frozen only while not tombstoned (parentOwnerRecent derives through it)', file: SOCIAL_V14, expect: 'wasm', why: /list "replyToReplyId" under `immutable` without a condition/i, mutate: (s) => {
    const reply = types(s).reply;
    reply.immutable = reply.immutable.map((e) => (e === 'replyToReplyId' ? { property: 'replyToReplyId', when: { absent: 'deleted' } } : e));
  } },
  { label: 'v14: rootPostId not frozen (rootOwnerRecent derives through it)', file: SOCIAL_V14, expect: 'wasm', why: /list "rootPostId" under `immutable` without a condition/i, mutate: (s) => { types(s).reply.immutable = types(s).reply.immutable.filter((e) => e !== 'rootPostId'); } },
  { label: 'v14: a quote-owner window on post (quotedPostId is frozen only until a tombstone)', file: SOCIAL_V14, expect: 'wasm', why: /list "quotedPostId" under `immutable` without a condition/i, mutate: (s) => {
    types(s).post.indices.push({ name: 'probe', properties: [{ $createdAt: 'asc' }, { 'quotedPostId.$ownerId': 'asc' }], skipIfAbsent: ['quotedPostId.$ownerId'], timeRange: { on: '$createdAt', range: 302400, step: 302400, ttl: 604800 } });
  } },
  // A derived skip property must be able to be absent: rootPostId is required and every post has an owner.
  { label: 'v14: rootOwnerRecent skipping on rootPostId.$ownerId (never absent)', file: SOCIAL_V14, expect: 'wasm', why: /never absent/i, mutate: (s) => { namedIndex(s, 'reply', 'rootOwnerRecent').skipIfAbsent = ['rootPostId.$ownerId']; } },
  // Only the array form names a derived property: `true` skips on stored properties alone, and both are required or system.
  { label: 'v14: parentOwnerRecent with skipIfAbsent: true (the boolean form skips on no derived property)', file: SOCIAL_V14, expect: 'wasm', why: /none of its properties is optional/i, mutate: (s) => { namedIndex(s, 'reply', 'parentOwnerRecent').skipIfAbsent = true; } },
  { label: 'v14: deleteConstraints on the indexOnly like', file: SOCIAL_V14, expect: 'wasm', why: /deleteConstraints.{0,80}indexOnly/i, mutate: (s) => { types(s).like.deleteConstraints = { r: { absent: 'hashtag' } }; } },
  { label: 'v14: deleteConstraints on post (canBeDeleted false: authors tombstone)', file: SOCIAL_V14, expect: 'wasm', why: /canBeDeleted: false/i, mutate: (s) => { types(s).post.deleteConstraints = { r: { present: 'deleted' } }; } },
  { label: 'v14: a deleteConstraints rule reading a property report does not have', file: SOCIAL_V14, expect: 'wasm', why: /presence of "state"/i, mutate: (s) => { types(s).report.deleteConstraints.pending = { absent: 'state' }; } },
  { label: 'v14: countPresent over a single path', file: SOCIAL_V14, expect: 'wasm', why: /two or more property paths/i, mutate: (s) => { types(s).report.propertyConstraints.oneTarget = { equal: [{ countPresent: ['postId'] }, 1] }; } },
  { label: 'v14: countPresent naming $ownerId', file: SOCIAL_V14, expect: 'wasm', why: /presence of "\$ownerId"/i, mutate: (s) => { types(s).report.propertyConstraints.oneTarget = { equal: [{ countPresent: ['postId', '$ownerId'] }, 1] }; } },
  { label: 'v14: countPresent repeating a path', file: SOCIAL_V14, expect: 'wasm', why: /repeats the path/i, mutate: (s) => { types(s).report.propertyConstraints.oneTarget = { equal: [{ countPresent: ['postId', 'postId'] }, 1] }; } },
  // deleteConstraints are frozen like propertyConstraints (validate_schema_compatibility v1).
  { label: 'v14 update: the report delete rule relaxed', file: SOCIAL_V14, expect: 'update', node: '10246', why: /deleteConstraints/i, update: (s) => { types(s).report.deleteConstraints.pending = { notEqual: ['status', 2] }; } },
  { label: 'v14 update: the report delete rule removed', file: SOCIAL_V14, expect: 'update', node: '10246', why: /deleteConstraints/i, update: (s) => { delete types(s).report.deleteConstraints; } },

  // Social v15 (5.0.0-beta.4, docs/SOCIAL_V15.md): v14 with a non-transferable YAPP whose costs
  // burn, written with the property type shorthands.
  { label: 'control: social v15 as committed (devnet: interim contractOwner)', file: SOCIAL_V15, mutate: () => {}, expect: 'accepted', holds: (s) => elected(s).interim.$type === 'contractOwner' },
  { label: 'control: social v15 as mainnet registers it (interim notYetUsable)', file: SOCIAL_V15, network: 'mainnet', mutate: () => {}, expect: 'accepted', holds: (s) => elected(s).interim.$type === 'notYetUsable' },
  { label: 'v15: YAPP is not transferable (read back off the parse), unpaused for good, unpriced, with no base supply and no shielded pool', file: SOCIAL_V15, mutate: () => {}, expect: 'accepted', holds: (s, parsed) => {
    const yapp = s.tokens['0'];
    const token = parsed.tokens[0];
    return yapp.$formatVersion === '1' && yapp.transferable === false && token.transferable === false && token.hasShieldedPool === false
      && yapp.startAsPaused === false && yapp.emergencyActionRules.authorizedToMakeChange.$type === 'noOne'
      && yapp.distributionRules.changeDirectPurchasePricingRules.authorizedToMakeChange.$type === 'noOne' && yapp.baseSupply === 0;
  } },
  { label: 'v15: every YAPP cost burns (effect 1), still optional with sponsored gas', file: SOCIAL_V15, mutate: () => {}, expect: 'accepted', holds: (s) => {
    const costs = Object.values(types(s)).flatMap((schema) => Object.values(schema.tokenCost ?? {}));
    return costs.length === 4 && costs.every((cost) => cost.effect === 1 && cost.optional === true && cost.gasFeesPaidBy === 2 && cost.tokenPosition === 0);
  } },
  { label: 'v15: a post cost paying the owner (effect 0) in the non-transferable YAPP', file: SOCIAL_V15, expect: 'dpp2', auditToo: true, node: '10280', why: /must burn it/i, mutate: (s) => { types(s).post.tokenCost.create.effect = 0; } },
  { label: 'v15: a like cost without an effect (the default pays the owner)', file: SOCIAL_V15, expect: 'dpp2', auditToo: true, node: '10280', why: /must burn it/i, mutate: (s) => { delete types(s).like.tokenCost.create.effect; } },
  { label: 'v15: the non-transferable YAPP with its own shielded pool', file: SOCIAL_V15, expect: 'audit', node: '10279', why: /shielded pool \(10279\)/, mutate: (s) => { s.tokens['0'].hasShieldedPool = true; } },
  { label: 'v15 with a transferable YAPP may pay the owner again (control: 10280 is about the flag)', file: SOCIAL_V15, expect: 'accepted', mutate: (s) => {
    s.tokens['0'].transferable = true;
    for (const schema of Object.values(types(s))) if (schema.tokenCost) schema.tokenCost.create.effect = 0;
  } },

  // The App Connect anchor (docs/APP_CONNECT_CONTRACTS.md): identities may hold ENCRYPTION keys
  // bound to it, and `identities.contractKeys` reads the empty key under the purpose subtree,
  // which only `MultipleReferenceToLatest` (2) writes as a pointer to the newest such key.
  { label: 'control: the App Connect anchor as committed (encryption opt-in 2, owner-only appInfo), read back off the parse', file: APP_ANCHOR, mutate: () => {}, expect: 'accepted', holds: (s, parsed) => {
    const { config } = parsed;
    return config.requiresIdentityEncryptionBoundedKey === 2 && config.requiresIdentityDecryptionBoundedKey == null
      && Object.keys(parsed.schemas).join() === 'appInfo' && Number(parsed.schemas.appInfo.creationRestrictionMode) === 1
      && parsed.schemas.appInfo.canBeDeleted === false && !s.config.moderation && !s.tokens;
  } },
  { label: 'control: the anchor as mainnet registers it (no moderation, so the same)', file: APP_ANCHOR, network: 'mainnet', mutate: () => {}, expect: 'accepted' },
  { label: 'anchor: an encryption opt-in of 3 (StorageKeyRequirements is 0, 1 or 2)', file: APP_ANCHOR, expect: 'wasm', mutate: (s) => { s.config.requiresIdentityEncryptionBoundedKey = 3; } },
  { label: 'anchor: Multiple (1) instead of MultipleReferenceToLatest (legal, not adopted: no current-key pointer for contractKeys to read)', file: APP_ANCHOR, expect: 'accepted', mutate: (s) => { s.config.requiresIdentityEncryptionBoundedKey = 1; } },
  { label: 'anchor: appInfo with creationRestrictionMode 3 (0, 1 or 2)', file: APP_ANCHOR, expect: 'wasm', why: /creation restriction mode/i, mutate: (s) => { types(s).appInfo.creationRestrictionMode = 3; } },
  { label: 'anchor: appInfo with a property outside the meta-schema', file: APP_ANCHOR, expect: 'dpp2', auditToo: true, node: '10101', mutate: (s) => { types(s).appInfo.properties.name.colour = 'blue'; } },

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

  // skipIfAbsent (#5162).
  { label: 'like without the all-time byHashtagPost (the "lean" variant)', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).like.indices = types(s).like.indices.filter((i) => i.name !== 'byHashtagPost'); } },
  { label: 'like.byHashtagPost without its own skipIfAbsent', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { delete types(s).like.indices.find((i) => i.name === 'byHashtagPost').skipIfAbsent; } },
  { label: 'skipIfAbsent on an index of required properties only', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).post.indices[0].skipIfAbsent = true; } },

  // Index shapes (V10-DESIGN §0): the wasm-sdk accepts every one; wasm-dpp2 and the audit refuse.
  { label: 'an index on a property the type does not have', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10209', mutate: (s) => { types(s).follow.indices.push({ name: 'probe', properties: [{ nope: 'asc' }] }); } },
  { label: 'an index on $id', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10208', mutate: (s) => { types(s).follow.indices.push({ name: 'probe', properties: [{ $id: 'asc' }] }); } },
  // 5.0.0-beta.5 indexes typed arrays per element (#5370); 5.0.0-beta.4's wasm-dpp2 refuses any (10206).
  { label: 'an index on a typed array whose elements are too long to key (socialLinks, 256 characters)', file: SOCIAL_V10, expect: 'dpp2', auditToo: true, node: '10205', why: /maxLength/i, mutate: (s) => { types(s).yapprProfile.indices.push({ name: 'probe', properties: [{ socialLinks: 'asc' }] }); } },
  { label: 'an index on a typed array within the element-index limits (socialLinks at 63 characters)', file: SOCIAL_V10, expect: 'accepted', mutate: (s) => {
    const links = types(s).yapprProfile.properties.socialLinks;
    links.items.maxLength = 63; links.items.maxBytes = 63;
    types(s).yapprProfile.indices.push({ name: 'probe', properties: [{ socialLinks: 'asc' }] });
  } },
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
  { label: 'propertyConstraints anyOf directly inside anyOf', file: STOREFRONT, expect: 'wasm', mutate: (s) => { types(s).storeItem.propertyConstraints = { r: { anyOf: [{ anyOf: [{ equal: ['weight', 0] }, { equal: ['weight', 1] }] }, { equal: ['weight', 2] }] } }; } },
  { label: 'tieredHasTiers comparing rateType with a value outside its enum', file: STOREFRONT, expect: 'wasm', mutate: (s) => { types(s).shippingZone.propertyConstraints.tieredHasTiers.anyOf[0] = { equal: ['rateType', { const: 'flat_rate' }] }; } },
  { label: 'resolvedHasStatus reading a property report does not have', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).report.propertyConstraints.resolvedHasStatus.anyOf[1] = { present: 'state' }; } },
  { label: 'privateAllOrNone reading a string property as an integer operand', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => { types(s).post.propertyConstraints.privateAllOrNone = { greaterThan: ['content', 0] }; } },
  { label: 'a 17th propertyConstraints rule on post (16 max)', file: SOCIAL_V10, expect: 'wasm', mutate: (s) => {
    const rules = types(s).post.propertyConstraints;
    for (let n = 0; Object.keys(rules).length < 17; n++) rules[`extra${n}`] = { absent: 'content' };
  } },
  // rs-dpp node_count counts operands too: the comparison, `add`, its 30 operands and the bound make 33.
  { label: 'a 33-node endsWithin31Days rule on poll (32 max)', file: POLLR, expect: 'wasm', mutate: (s) => {
    types(s).poll.propertyConstraints.endsWithin31Days = { lessThanOrEqual: [{ add: ['endsAt', ...Array.from({ length: 29 }, (_, i) => i + 1)] }, 2_678_400_000] };
  } },
  // Pollr v6 (5.0.0-beta.3): a deleteConstraints countOf total needs a plain countable index
  // whose properties are exactly the filter's keys. byPollChoice [pollId, choices] is not one.
  { label: 'pollr: noBallots counting vote by pollId without byPoll', file: POLLR, expect: 'wasm', why: /no countable index/i, mutate: (s) => {
    const vote = types(s).vote;
    vote.indices = vote.indices.filter((index) => index.name !== 'byPoll');
  } },

  // 5.0.0-beta.5: `where` conditions, rules reading the referenced document or the stored version,
  // and typed-array element indexes. A `where` condition's registration rules (40126) run on the
  // node only, so the audit models them; the parses refuse a bad element index or rule.
  { label: 'control: pollr v7 declares its close as a where condition, its rules read the poll, and its tally indexes the choices', file: POLLR, mutate: () => {}, expect: 'accepted', holds: (s) => {
    const vote = types(s).vote;
    const rules = vote.propertyConstraints;
    return JSON.stringify(vote.properties.pollId.refersTo.where) === '{"endsAt":{"greaterThanOrEqual":"$updatedAt"}}'
      && JSON.stringify(Object.keys(rules).sort()) === '["choicesAreOptions","choicesAreOptionsHigh","singleChoice"]'
      && Object.values(rules).every((rule) => JSON.stringify(rule).includes('"referenced":["pollId",'))
      && typedArrayOf(vote, namedIndex(s, 'vote', 'byPollChoice')) === 'choices'
      && !types(s).poll.properties.optionCount && vote.properties.choices.maxItems === 10;
  } },
  { label: 'pollr v7: the close bounded by $transferredAt, which vote does not require', file: POLLR, expect: 'audit', node: '40126', why: /does not list \$transferredAt/, mutate: (s) => {
    types(s).vote.properties.pollId.refersTo.where.endsAt = { greaterThanOrEqual: '$transferredAt' };
  } },
  { label: 'pollr v7: a where condition on the options typed array', file: POLLR, expect: 'audit', node: '40126', why: /holds no single value/, mutate: (s) => {
    types(s).vote.properties.pollId.refersTo.where.options = { const: 'a' };
  } },
  { label: 'pollr v7: an ordering on the boolean multiChoice', file: POLLR, expect: 'audit', node: '40126', why: /is not an integer/, mutate: (s) => {
    types(s).vote.properties.pollId.refersTo.where.multiChoice = { greaterThan: { const: 0 } };
  } },
  { label: 'pollr v7: choices of 17 under the element index (16 max)', file: POLLR, expect: 'dpp2', auditToo: true, node: '10205', why: /maxItems/i, mutate: (s) => {
    Object.assign(types(s).vote.properties.choices, { maxItems: 17 });
    types(s).vote.properties.choices.items.maximum = 16;
  } },
  { label: 'storefront v8: the order where condition names a property the store lacks', file: STOREFRONT, expect: 'audit', node: '40126', why: /does not have/, mutate: (s) => { types(s).storeOrder.properties.storeId.refersTo.where = { $ownerId: 'sellerId', state: { const: 'active' } }; } },
  { label: 'storefront v8: the order where condition with a status outside the store\'s enum', file: STOREFRONT, expect: 'audit', node: '40126', why: /"open" is not a value/, mutate: (s) => { types(s).storeOrder.properties.storeId.refersTo.where.status = { const: 'open' }; } },
  { label: 'storefront v8: an order no longer carries storeStatus, and storeOrder declares no rule', file: STOREFRONT, mutate: () => {}, expect: 'accepted', holds: (s) => !types(s).storeOrder.properties.storeStatus && !types(s).storeOrder.propertyConstraints },
  // Storefront v9 (docs/STOREFRONT_V9.md) is v8 plus one optional storeItem property, so a
  // registered v8 contract takes it as a data contract update.
  { label: 'storefront v9 update: v8 (no shippingZoneIds) updated in place to the committed v9', file: STOREFRONT, expect: 'accepted', base: (s) => { delete types(s).storeItem.properties.shippingZoneIds; }, update: (s) => { types(s).storeItem.properties.shippingZoneIds = structuredClone(types(JSON.parse(readFileSync(STOREFRONT, 'utf8'))).storeItem.properties.shippingZoneIds); } },
  { label: 'blog v8: comments-off as notEqual a string const on the boolean commentsEnabled', file: BLOG, expect: 'audit', node: '40126', why: /is not a value/, mutate: (s) => { types(s).blogComment.properties.blogPostId.refersTo.where.commentsEnabled = { notEqual: { const: 'false' } }; } },
  { label: 'blog v8: a comment no longer copies its post\'s flag', file: BLOG, mutate: () => {}, expect: 'accepted', holds: (s) => !types(s).blogComment.properties.postCommentsEnabled && !types(s).blogComment.propertyConstraints },
  { label: 'social v15: post and reply mention up to 8 identities, indexed per element, cleared by a tombstone', file: SOCIAL_V15, mutate: () => {}, expect: 'accepted', holds: (s) => ['post', 'reply'].every((type) => {
    const schema = types(s)[type];
    const index = schema.indices.find((i) => i.name === 'mentionedUserAndTime');
    return schema.properties.mentionedUserIds?.maxItems === 8 && !schema.properties.mentionedUserId
      && JSON.stringify(index.properties) === '[{"mentionedUserIds":"asc"},{"$createdAt":"asc"}]' && index.skipIfAbsent === undefined
      && JSON.stringify(schema.propertyConstraints.blankTombstone).includes('"mentionedUserIds"')
      && schema.immutable.some((entry) => entry.property === 'mentionedUserIds' && entry.when?.absent === 'deleted');
  }) },
  { label: 'social v15: mentionedUserAndTime skipping on the mentions array alone', file: SOCIAL_V15, expect: 'wasm', node: '10231', why: /skip/i, mutate: (s) => { namedIndex(s, 'post', 'mentionedUserAndTime').skipIfAbsent = true; } },
  { label: 'social v15: 9 mentions under a 3.5-day window index (4 max under a window)', file: SOCIAL_V15, expect: 'dpp2', node: '10205', why: /maxItems|under a window/i, mutate: (s) => {
    types(s).post.indices.push({ name: 'probe', properties: [{ $createdAt: 'asc' }, { mentionedUserIds: 'asc' }], timeRange: { on: '$createdAt', range: 302400, step: 302400, ttl: 604800 } });
  } },
  // A second, keyable array (media URLs are too long to key, which would be refused first).
  { label: 'social v15: one index naming two typed arrays (mentions and a short tag list)', file: SOCIAL_V15, expect: 'dpp2', node: '10231', why: /typed arrays?/i, mutate: (s) => {
    const next = Math.max(...Object.values(types(s).post.properties).map((p) => p.position)) + 1;
    types(s).post.properties.probeTags = { type: 'array', maxItems: 4, items: { type: 'integer', minimum: 0, maximum: 9 }, position: next };
    types(s).post.indices.push({ name: 'probe', properties: [{ mentionedUserIds: 'asc' }, { probeTags: 'asc' }] });
  } },
  { label: 'social v15: a resolved report stays resolved (staysResolved reads $old.status)', file: SOCIAL_V15, mutate: () => {}, expect: 'accepted', holds: (s) => JSON.stringify(types(s).report.propertyConstraints.staysResolved) === '{"ifThen":[{"present":"$old.status"},{"present":"status"}]}' },

  // Social v16 (5.0.0-beta.6, docs/SOCIAL_V16.md): v15 with up to four tags per post in the typed
  // array `tags`, which a like repeats as a list (#5388), so the like enters byHashtagPost and
  // byTrendHashtagPost once per tag (#5390) and byHashtagPost stays a preallocated counter of byPost
  // (#5394). Recorded from the beta.6 book and tests: the 5.0.0-beta.5 wasm-dpp2 refuses every
  // typed-array index of an indexOnly type (10231), so on the beta.5 packages every v16 probe that
  // gets past the wasm-sdk parse stops at `dpp2` on that rule instead.
  { label: 'control: social v16 as committed (devnet: interim contractOwner)', file: SOCIAL_V16, mutate: () => {}, expect: 'accepted', holds: (s) => elected(s).interim.$type === 'contractOwner' },
  { label: 'control: social v16 as mainnet registers it (interim notYetUsable)', file: SOCIAL_V16, network: 'mainnet', mutate: () => {}, expect: 'accepted', holds: (s) => elected(s).interim.$type === 'notYetUsable' },
  { label: 'social v16: post and like carry 1 to 4 distinct tags, the like bound to the post\'s list, every tag index keyed per element without skipIfAbsent, the list frozen and kept by a removal', file: SOCIAL_V16, mutate: () => {}, expect: 'accepted', holds: (s) => {
    const { post, like } = types(s);
    const list = '{"type":"array","minItems":1,"maxItems":4,"uniqueItems":true,"items":{"type":"string","pattern":"^[a-z0-9_]{1,61}$","maxLength":61}';
    const keys = (index) => JSON.stringify(index.properties.map((p) => Object.keys(p)[0]));
    const tagIndexes = [namedIndex(s, 'post', 'tagAndTime'), namedIndex(s, 'like', 'byHashtagPost'), namedIndex(s, 'like', 'byTrendHashtagPost')];
    return JSON.stringify(post.properties.tags).startsWith(list) && JSON.stringify(like.properties.tags).startsWith(list)
      && !post.properties.hashtag && !like.properties.hashtag
      && JSON.stringify(like.properties.postId.refersTo.where) === '{"tags":"tags","$ownerId":"postAuthor"}'
      && keys(tagIndexes[0]) === '["tags","$createdAt"]' && keys(tagIndexes[1]) === '["tags","postId"]' && keys(tagIndexes[2]) === '["$createdAt","tags","postId"]'
      && tagIndexes.every((index) => index.skipIfAbsent === undefined)
      && tagIndexes[1].summableOffCountIndex === 'byPost' && tagIndexes[1].preallocated === true
      && post.immutable.includes('tags') && post.moderatorAbilities.deleteKeepsFields.includes('tags');
  } },
  { label: 'social v16: tagAndTime skipping on the tags array alone', file: SOCIAL_V16, expect: 'wasm', node: '10231', why: /skip/i, mutate: (s) => { namedIndex(s, 'post', 'tagAndTime').skipIfAbsent = true; } },
  { label: 'social v16: like.byHashtagPost skipping on the tags array alone', file: SOCIAL_V16, expect: 'wasm', node: '10231', why: /skip/i, mutate: (s) => { namedIndex(s, 'like', 'byHashtagPost').skipIfAbsent = true; } },
  // The post's list must fit the like's, so both are raised; the 24h window then enters a like 5 times per window.
  { label: 'social v16: 5 tags under the 24h byTrendHashtagPost window (4 max under a window)', file: SOCIAL_V16, expect: 'dpp2', auditToo: true, node: '10205', why: /maxItems|under a window/i, mutate: (s) => {
    for (const type of ['post', 'like']) types(s)[type].properties.tags.maxItems = 5;
  } },
  // An indexOnly type's array index is kept apart by byPost, not by itself, so its list must not repeat an element.
  { label: 'social v16: like.tags without uniqueItems (an indexOnly type\'s array index needs it)', file: SOCIAL_V16, expect: 'wasm', node: '10231', why: /uniqueItems/i, mutate: (s) => { delete types(s).like.properties.tags.uniqueItems; } },
  // [tags, postAuthor] → $ownerId would refuse a second like of the same author's posts under one tag:
  // byPost's key (postId, $ownerId) is not inside its key without the array, so nothing keeps it apart.
  { label: 'social v16: a like index [tags, postAuthor] → $ownerId that byPost does not keep apart', file: SOCIAL_V16, expect: 'wasm', node: '10231', why: /"probe"/, mutate: (s) => {
    types(s).like.indices.push({ name: 'probe', properties: [{ tags: 'asc' }, { postAuthor: 'asc' }], terminal: '$ownerId' });
  } },
  // A typed array pairs only with a typed array (#5388); a post quoting a post binds nothing to the
  // quoted post's tags, so the pairing is isolated from the like's preallocated trees.
  { label: 'social v16: a where pairing the tags list with a scalar (post.quotedPostId where { tags: "embedDocType" })', file: SOCIAL_V16, expect: 'audit', node: '40126', why: /typed array pairs only with a typed array/, mutate: (s) => {
    types(s).post.properties.quotedPostId.refersTo.where.tags = 'embedDocType';
  } },
  { label: 'social v16: preallocated byHashtagPost when the removal record does not keep the tags', file: SOCIAL_V16, expect: 'wasm', mutate: (s) => { types(s).post.moderatorAbilities.deleteKeepsFields = ['$createdAt']; } },
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
  // v14 stores no owner on a reply: there is nothing left to forge, so the root reference binds
  // nothing, and the windows read the owners off the referenced documents. A nested reply still
  // stays in its parent's thread.
  ['v14: a top-level reply names no owner (rootPostId binds nothing)', SOCIAL_V14, 'reply', 'rootPostId', {}, { $ownerId: 'alice' }, null],
  ['v14: a nested reply in its parent\'s thread', SOCIAL_V14, 'reply', 'replyToReplyId', { rootPostId: 'thread1' }, { $ownerId: 'bob', rootPostId: 'thread1' }, null],
  ['v14: a nested reply crossing threads (its parent is in another thread)', SOCIAL_V14, 'reply', 'replyToReplyId', { rootPostId: 'thread1' }, { $ownerId: 'bob', rootPostId: 'thread2' }, '40127'],
  ['v14: a post report naming someone else as the author', SOCIAL_V14, 'report', 'postId', { targetOwnerId: 'bob' }, { $ownerId: 'alice' }, '40127'],
  // 5.0.0-beta.5 conditions. Pollr v7: a ballot written before the close, at it, and after it
  // ($updatedAt is the write's block time, on a create and on every replace).
  ['pollr v7: a ballot written before the close', POLLR, 'vote', 'pollId', { $updatedAt: 1_000 }, { endsAt: 2_000 }, null],
  ['pollr v7: a ballot written at the close', POLLR, 'vote', 'pollId', { $updatedAt: 2_000 }, { endsAt: 2_000 }, null],
  ['pollr v7: a ballot written after the close', POLLR, 'vote', 'pollId', { $updatedAt: 2_001 }, { endsAt: 2_000 }, '40127'],
  // Storefront v8: an order at an active store of its seller; paused, closed or no status refused.
  ['storefront v8: an order at an active store', STOREFRONT, 'storeOrder', 'storeId', { sellerId: 'alice' }, { $ownerId: 'alice', status: 'active' }, null],
  ['storefront v8: an order at a paused store', STOREFRONT, 'storeOrder', 'storeId', { sellerId: 'alice' }, { $ownerId: 'alice', status: 'paused' }, '40127'],
  ['storefront v8: an order at a closed store', STOREFRONT, 'storeOrder', 'storeId', { sellerId: 'alice' }, { $ownerId: 'alice', status: 'closed' }, '40127'],
  ['storefront v8: an order naming someone else as the seller', STOREFRONT, 'storeOrder', 'storeId', { sellerId: 'bob' }, { $ownerId: 'alice', status: 'active' }, '40127'],
  // Blog v8: comments are on unless the post sets commentsEnabled false (a tombstone does).
  ['blog v8: a comment on a post with comments on', BLOG, 'blogComment', 'blogPostId', {}, { commentsEnabled: true }, null],
  ['blog v8: a comment on a post that leaves commentsEnabled out', BLOG, 'blogComment', 'blogPostId', {}, {}, null],
  ['blog v8: a comment on a post with comments off', BLOG, 'blogComment', 'blogPostId', {}, { commentsEnabled: false }, '40127'],
  // Social v16: a like repeats its post's tags as a list (5.0.0-beta.6, #5388), the same elements in
  // the same order; a list left out is the empty one.
  ['v16: a like carrying its post\'s two tags', SOCIAL_V16, 'like', 'postId', { tags: ['dash', 'news'], postAuthor: 'alice' }, { $ownerId: 'alice', tags: ['dash', 'news'] }, null],
  ['v16: a like carrying its post\'s tags reordered', SOCIAL_V16, 'like', 'postId', { tags: ['news', 'dash'], postAuthor: 'alice' }, { $ownerId: 'alice', tags: ['dash', 'news'] }, '40127'],
  ['v16: a like carrying one of its post\'s two tags', SOCIAL_V16, 'like', 'postId', { tags: ['dash'], postAuthor: 'alice' }, { $ownerId: 'alice', tags: ['dash', 'news'] }, '40127'],
  ['v16: a like adding a tag its post does not have', SOCIAL_V16, 'like', 'postId', { tags: ['dash', 'news', 'gm'], postAuthor: 'alice' }, { $ownerId: 'alice', tags: ['dash', 'news'] }, '40127'],
  ['v16: an untagged like of an untagged post (both lists left out)', SOCIAL_V16, 'like', 'postId', { postAuthor: 'alice' }, { $ownerId: 'alice' }, null],
  ['v16: a tagged like of an untagged post', SOCIAL_V16, 'like', 'postId', { tags: ['dash'], postAuthor: 'alice' }, { $ownerId: 'alice' }, '40127'],
  ['v16: an untagged like of a tagged post', SOCIAL_V16, 'like', 'postId', { postAuthor: 'alice' }, { $ownerId: 'alice', tags: ['dash'] }, '40127'],
];

/**
 * Two `where` values as consensus compares them: single values by value; two
 * typed arrays as lists (5.0.0-beta.6, #5388), the same elements in the same
 * order, a list left out being the empty one.
 */
function sameWhereValue(a, b) {
  if (!Array.isArray(a) && !Array.isArray(b)) return a === b;
  const [x, y] = [a ?? [], b ?? []];
  return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((element, i) => element === y[i]);
}

/**
 * Whether one `where` entry holds, as consensus judges it (book refers-to.md
 * "Conditions" and "Typed arrays"). An equality agrees when both sides are
 * absent and fails when one is, and two lists agree element for element in
 * order; a `const` or `in` fails on an absent referenced side; a `notEqual` is
 * the negated equality; an ordering holds only when both sides have a value; a
 * `contains` holds when the list holds the value (never one left out), a
 * `containsAll` when it holds every element of the referring list.
 */
function whereEntryHolds(theirs, condition, referring) {
  const side = (bound) => (bound && typeof bound === 'object' ? bound.const : referring[bound]);
  if (typeof condition === 'string') return sameWhereValue(theirs, referring[condition]);
  const [[kind, bound]] = Object.entries(condition);
  if (kind === 'contains') return referring[bound] !== undefined && (theirs ?? []).includes(referring[bound]);
  if (kind === 'containsAll') return (referring[bound] ?? []).every((element) => (theirs ?? []).includes(element));
  if (kind === 'const') return theirs !== undefined && theirs === bound;
  if (kind === 'in') return theirs !== undefined && bound.includes(theirs);
  if (kind === 'notEqual') return theirs !== side(bound);
  const mine = side(bound);
  if (theirs === undefined || mine === undefined) return false;
  return { greaterThan: theirs > mine, greaterThanOrEqual: theirs >= mine, lessThan: theirs < mine, lessThanOrEqual: theirs <= mine }[kind];
}

function runWhereCases({ loadContractSource, parseContract }) {
  let failures = 0;
  const parsed = new Map();
  console.log('\nreference `where` agreements (equalities read off the parsed contract, 5.0.0-beta.5 conditions off the file; the node refuses a disagreement with 40127):');
  for (const [label, file, type, path, referring, referenced, expected] of WHERE_CASES) {
    if (!parsed.has(file)) {
      const source = loadContractSource(file);
      parsed.set(file, { contract: parseContract(source), source });
    }
    const { contract, source } = parsed.get(file);
    const reference = contract.documentTypeReferences(type).find((r) => r.path === path);
    // Conditions come off the file: the parse reports them in a shape of its own.
    const declared = source.documentSchemas[type]?.properties?.[path]?.refersTo?.where ?? {};
    const where = {
      ...Object.fromEntries(Object.entries(reference?.where ?? {}).filter(([, mine]) => typeof mine === 'string')),
      ...Object.fromEntries(Object.entries(declared).filter(([, condition]) => typeof condition !== 'string')),
    };
    const disagreement = Object.entries(where).find(([theirs, condition]) => !whereEntryHolds(referenced[theirs], condition, referring));
    const outcome = reference && disagreement ? '40127' : null;
    const ok = reference !== undefined && outcome === expected;
    if (!ok) failures += 1;
    const detail = disagreement ? `${type}.${path} where ${disagreement[0]} ${JSON.stringify(disagreement[1])} fails on ${JSON.stringify(referenced[disagreement[0]] ?? null)}` : `where ${JSON.stringify(where)} agrees`;
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
    // An update probe may start from an earlier cut of the committed file (version 1).
    probe.base?.(stored);
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
