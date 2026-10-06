/**
 * The registration rules the local parses do NOT run, re-checked offline,
 * and the negative probes that record which refusals are local and which only
 * a node makes. Used by `validate-contract-offline.mjs`.
 *
 * Three layers, measured on 4.2.0-beta.7 and re-run on 5.0.0-beta.1 with
 * `DataContract.fromJSON(json, true, latest)`:
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
const INTERIM_KINDS = ['contractOwner', 'appointedModerators', 'notYetUsable', 'noModeration'];

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
const SOCIAL_V9 = 'contracts/yappr-social-contract-v9.json';
const STOREFRONT = 'contracts/yappr-storefront-contract.json';
const PROFILE = 'contracts/yappr-profile-contract.json';
const BLOG = 'contracts/yappr-blog-contract.json';

const elected = (source) => source.config.moderation.moderators;
const types = (source) => source.documentSchemas;
const identifier = (position, refersTo) => ({ type: 'array', byteArray: true, minItems: 32, maxItems: 32, contentMediaType: 'application/x.dash.dpp.identifier', position, ...(refersTo ? { refersTo } : {}) });

/**
 * Each probe mutates a committed cut and records the first layer that refuses
 * it: `wasm` = the wasm-sdk parse, `dpp2` = parses in the wasm-sdk but the
 * wasm-dpp2 parse (meta-schema + `validation`) refuses it, `audit` = both
 * parse and only `auditNodeRules` (or the size cap) refuses it — the node
 * does, and the SDK signs it — or `accepted` for a control. `auditToo` also
 * requires the audit to flag a `dpp2` probe, pinning the ported index checks.
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
 * Runs every probe; returns the number whose outcome differs from the recorded
 * one. `parseContract` is the wasm-sdk parse, `parseWithNodeRules` the
 * wasm-dpp2 one.
 */
export function runContractProbes({ loadContractSource, parseContract, parseWithNodeRules, sizeOf }) {
  let failures = 0;
  console.log('\nnegative probes (wasm = refused by the wasm-sdk parse; dpp2 = only by the wasm-dpp2 parse; audit = both parse, the node refuses):');
  for (const probe of PROBES) {
    const source = structuredClone(loadContractSource(probe.file));
    probe.mutate(source);
    const refusal = (parse) => { try { parse(source); return null; } catch (e) { return String(e?.message ?? e); } };
    const wasmError = refusal(parseContract);
    const dpp2Error = wasmError ? null : refusal(parseWithNodeRules);
    const audit = [];
    if (!wasmError) {
      audit.push(...auditNodeRules(source, { network: probe.network ?? 'devnet' }), ...metaSchemaProblems(source));
      const size = sizeOf(parseContract(source));
      if (size.overCap) audit.push(`create transition ~${size.bytes} B, over the ${STATE_TRANSITION_CAP} B cap`);
    }
    const outcome = wasmError ? 'wasm' : dpp2Error ? 'dpp2' : audit.length > 0 ? 'audit' : 'accepted';
    const auditMissed = probe.auditToo && audit.length === 0;
    const ok = outcome === probe.expect && !auditMissed;
    if (!ok) failures += 1;
    const detail = wasmError ?? dpp2Error ?? audit[0] ?? '';
    const where = outcome === 'audit' || outcome === 'dpp2' ? ` (node: ${probe.node ?? '?'}; the SDK signs it)` : '';
    const note = auditMissed ? ' (auditNodeRules did not flag it)' : '';
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${outcome.padEnd(8)}] ${probe.label}${where}${detail ? ` — ${detail.replace(/\s+/g, ' ').slice(0, 150)}` : ''}${note}${outcome === probe.expect ? '' : ` (expected ${probe.expect})`}`);
  }
  return failures;
}
