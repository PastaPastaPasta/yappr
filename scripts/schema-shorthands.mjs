/**
 * Property type shorthands (protocol 14, Platform 5.0.0-beta.4): a contract may
 * write a 32-byte identifier as `{"type": "identifier"}` and a fixed-size byte
 * array as `{"type": "bytes", "size": n}`. Platform stores the short form (it
 * costs fewer bytes on chain) and expands it before the meta-schema and the
 * parser read the schema, so every script that reads a schema's shape
 * (`byteArray`, `minItems`, `contentMediaType`, …) reads it through here.
 *
 * As rs-dpp's `expand_property_type_shorthands` does, the shorthands are looked
 * for in the members of a type's `properties` and `$defs` and, below them, in
 * nested `properties` and typed-array `items`, never inside a `refersTo`, an
 * `enum` or any other keyword's value. A malformed one (beside its long-form
 * keywords, an identifier with a `size`, a `bytes` without one) is left as
 * written, for the parse to refuse.
 */

const IDENTIFIER_MEDIA_TYPE = 'application/x.dash.dpp.identifier';
const LONG_FORM_KEYWORDS = ['byteArray', 'minItems', 'maxItems', 'contentMediaType'];

/** A JSON object (rs-dpp walks maps only: an array `properties` or `items` holds no property schema). */
const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The byte count a well-formed shorthand stands for, or null when `schema` declares none. */
function shorthandSize(schema) {
  if (LONG_FORM_KEYWORDS.some((keyword) => keyword in schema)) return null;
  if (schema.type === 'identifier') return schema.size === undefined ? 32 : null;
  if (schema.type === 'bytes') return Number.isInteger(schema.size) && schema.size >= 1 ? schema.size : null;
  return null;
}

/** One property schema with its shorthand, and every shorthand below it, written in full. */
function expandProperty(schema) {
  if (!isMap(schema)) return schema;
  const size = shorthandSize(schema);
  let out = { ...schema };
  if (size !== null) {
    const identifier = out.type === 'identifier';
    delete out.size;
    out = { ...out, type: 'array', byteArray: true, minItems: size, maxItems: size, ...(identifier ? { contentMediaType: IDENTIFIER_MEDIA_TYPE } : {}) };
  }
  if (isMap(out.properties)) out.properties = expandMembers(out.properties);
  if (isMap(out.items)) out.items = expandProperty(out.items);
  return out;
}

function expandMembers(members) {
  return Object.fromEntries(Object.entries(members).map(([name, schema]) => [name, expandProperty(schema)]));
}

/** A document type schema with every property type shorthand written in full (a copy; the input is not changed). */
export function expandShorthands(documentSchema) {
  if (!isMap(documentSchema)) return documentSchema;
  const out = { ...documentSchema };
  for (const key of ['properties', '$defs']) {
    if (isMap(out[key])) out[key] = expandMembers(out[key]);
  }
  return out;
}

/** Every document type of `documentSchemas` with its shorthands written in full. */
export function expandSchemas(documentSchemas) {
  return Object.fromEntries(Object.entries(documentSchemas).map(([name, schema]) => [name, expandShorthands(schema)]));
}
