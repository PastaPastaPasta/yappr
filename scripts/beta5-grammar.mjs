/**
 * The Platform 5.0.0-beta.5 grammar Yappr's cuts use, and how the offline
 * tooling judges it while the repo's SDK is older (docs/PLATFORM_V5_BETA5_UPGRADE.md).
 *
 * beta.5 (protocol 14, no state migration) adds four constructs the beta.5
 * cuts of pollr, storefront, blog and social v15 declare:
 *
 *   - `whereCondition`: a `refersTo.where` entry valued with a condition
 *     object (`{ "const": v }`, `{ "notEqual": … }`, `{ "in": […] }`, an
 *     ordering) instead of a referring property (#5369); a document found that
 *     fails it is refused 40127.
 *   - `referencedRead`: a `propertyConstraints` rule reading the document a
 *     reference points at, `{ "referenced": [reference, field] }` (#5369).
 *   - `storedVersionRead`: a `propertyConstraints` rule reading the stored
 *     version, `$old.<path>` or `$revision` (#5373). (`immutable` conditions
 *     and `retractedWhen` read `$old.` since 5.0.0-beta.1.)
 *   - `typedArrayIndex`: an index naming a typed array, one entry per element
 *     (#5370).
 *
 * The 5.0.0-beta.4 packages cannot parse them: the wasm-sdk refuses the
 * conditions and both kinds of rule (10231), wasm-dpp2 also refuses an
 * element index (10206; the wasm-sdk lets one through without checking it).
 * Until the SDK bump, `beta4Rendering` strips exactly these
 * constructs, and nothing else, before the wasm parses, and every caller says
 * which it stripped. The node-rule audit (`auditNodeRules`) and the vendored
 * beta.5 meta-schema still judge the whole file, and rs-dpp 5.0.0-beta.5's
 * own full validation (`b5val`) is the authority for the stripped parts. The
 * publisher refuses to build a create carrying them on an older SDK
 * (`requireSdkFor`): nothing is ever registered in its stripped form.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The installed `@dashevo/evo-sdk` version, e.g. `5.0.0-beta.4` (its exports map hides package.json from resolve). */
export const SDK_VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@dashevo', 'evo-sdk', 'package.json'), 'utf8')).version;

/** Whether `version` (`5.0.0-beta.N`, `-rc.N` or a release) is 5.0.0-beta.5 or later. */
export function parsesBeta5(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const [tag, number] = [match[4], Number(match[5])];
  if (major !== 5 || minor !== 0 || patch !== 0) return major >= 5;
  return tag === undefined || tag === 'rc' || (tag === 'beta' && number >= 5);
}

/** True once the installed SDK parses the beta.5 grammar itself. */
export const SDK_PARSES_BETA5 = parsesBeta5(SDK_VERSION);

/** Every value nested in `node` (objects and arrays), depth first. */
function* walk(node) {
  yield node;
  if (Array.isArray(node)) for (const item of node) yield* walk(item);
  else if (node && typeof node === 'object') for (const value of Object.values(node)) yield* walk(value);
}

const readsReferenced = (rule) => [...walk(rule)].some((node) => node && typeof node === 'object' && !Array.isArray(node) && 'referenced' in node);
const readsStored = (rule) => [...walk(rule)].some((node) => typeof node === 'string' && (node.startsWith('$old.') || node === '$revision'));

/** The reference declarations of a property schema: its own, its items', and the leaves of anyOf/allOf. */
function references(definition) {
  const out = [];
  const leaves = (ref) => {
    for (const key of ['anyOf', 'allOf']) if (Array.isArray(ref[key])) { for (const leaf of ref[key]) leaves(leaf); return; }
    out.push(ref);
  };
  if (definition?.refersTo) leaves(definition.refersTo);
  if (definition?.items?.refersTo) leaves(definition.items.refersTo);
  return out;
}

/** Every [path, refersTo] of a document type, nested object properties included, plus ownerRefersTo/creatorRefersTo. */
function referenceDeclarations(schema) {
  const out = [];
  for (const key of ['ownerRefersTo', 'creatorRefersTo']) if (schema[key]) out.push(...references({ refersTo: schema[key] }).map((ref) => [`$${key.slice(0, -'RefersTo'.length)}Id`, ref]));
  const visit = (properties, prefix) => {
    for (const [name, definition] of Object.entries(properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      out.push(...references(definition).map((ref) => [path, ref]));
      if (definition?.type === 'object') visit(definition.properties, path);
    }
  };
  visit(schema.properties, '');
  return out;
}

/** The property names an index lists, in order. */
export const indexPropertyNames = (index) => index.properties.map((entry) => Object.keys(entry)[0]);

/** Whether a property definition is a typed array (not a byte array). */
export const isTypedArray = (definition) => definition?.type === 'array' && definition.byteArray !== true && definition.items !== undefined;

/** The typed array property `index` names, or undefined. */
export const typedArrayOf = (schema, index) => indexPropertyNames(index).find((property) => isTypedArray(schema.properties?.[property]));

/**
 * The beta.5-only constructs a contract source declares, as
 * `{ kind, type, at, name? }` (`at` names the place: a reference path, a
 * rule, an index).
 */
export function beta5Constructs(source) {
  const found = [];
  for (const [type, schema] of Object.entries(source.documentSchemas)) {
    for (const [path, ref] of referenceDeclarations(schema)) {
      for (const [field, value] of Object.entries(ref.where ?? {})) {
        if (typeof value !== 'string') found.push({ kind: 'whereCondition', type, at: `${path} where ${field} ${JSON.stringify(value)}` });
      }
    }
    for (const [name, rule] of Object.entries(schema.propertyConstraints ?? {})) {
      if (readsReferenced(rule)) found.push({ kind: 'referencedRead', type, at: `rule ${name}`, name });
      if (readsStored(rule)) found.push({ kind: 'storedVersionRead', type, at: `rule ${name}`, name });
    }
    for (const index of schema.indices ?? []) {
      const array = typedArrayOf(schema, index);
      if (array) found.push({ kind: 'typedArrayIndex', type, at: `index ${index.name} [${array}]`, name: index.name });
    }
  }
  return found;
}

/** One line per construct, for the tools to print. */
export const describeConstructs = (constructs) => constructs.map(({ kind, type, at }) => `${type}: ${at} (${kind})`);

/**
 * `source` as the installed SDK can parse it: unchanged on a beta.5 SDK;
 * otherwise a copy without exactly the beta.5 constructs (`beta5Constructs`):
 * condition entries leave their `where` (an emptied `where` goes), rules
 * reading a referenced document or the stored version leave
 * `propertyConstraints` (an emptied one goes), and indexes naming a typed
 * array leave `indices`. Returns `{ source, stripped }`; `stripped` lists
 * what went. For the offline wasm parses only: never sign or publish it.
 */
export function beta4Rendering(source) {
  const constructs = beta5Constructs(source);
  if (SDK_PARSES_BETA5 || constructs.length === 0) return { source, stripped: [] };
  const lowered = structuredClone(source);
  for (const schema of Object.values(lowered.documentSchemas)) {
    for (const [, ref] of referenceDeclarations(schema)) {
      if (!ref.where) continue;
      for (const [field, value] of Object.entries(ref.where)) if (typeof value !== 'string') delete ref.where[field];
      if (Object.keys(ref.where).length === 0) delete ref.where;
    }
    if (schema.propertyConstraints) {
      for (const [name, rule] of Object.entries(schema.propertyConstraints)) if (readsReferenced(rule) || readsStored(rule)) delete schema.propertyConstraints[name];
      if (Object.keys(schema.propertyConstraints).length === 0) delete schema.propertyConstraints;
    }
    if (schema.indices) schema.indices = schema.indices.filter((index) => !typedArrayOf(schema, index));
  }
  return { source: lowered, stripped: constructs };
}

/** The rule names `beta4Rendering` strips from `docType`, so case runners can tell a skipped rule from a missing one. */
export const strippedRules = (stripped, docType) => new Set(stripped.filter((c) => c.type === docType && c.name && c.kind !== 'typedArrayIndex').map((c) => c.name));

/**
 * Throws when `source` uses beta.5 grammar the installed SDK cannot build: a
 * create the publisher signs must carry the file as written.
 */
export function requireSdkFor(source, what) {
  if (SDK_PARSES_BETA5) return;
  const constructs = beta5Constructs(source);
  if (constructs.length === 0) return;
  throw new Error(`${what} uses Platform 5.0.0-beta.5 grammar the installed SDK ${SDK_VERSION} cannot build `
    + `(${describeConstructs(constructs).join('; ')}). Register it with the 5.0.0-beta.5 SDK.`);
}
