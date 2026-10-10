/**
 * Property type shorthands (protocol 14, Platform 5.0.0-beta.4): a contract may
 * write a 32-byte identifier as `{"type": "identifier"}` and a fixed-size byte
 * array as `{"type": "bytes", "size": n}`. Platform stores the short form (it
 * costs fewer bytes on chain) and expands it before the meta-schema and the
 * parser read the schema, so every script that reads a schema's shape
 * (`byteArray`, `minItems`, `contentMediaType`, …) reads it through here.
 *
 * Ported from rs-dpp `expand_property_type_shorthands` (document_type/schema/
 * expand_property_type_shorthands/v0): the shorthands are looked for in the
 * members of a type's `properties` and `$defs` and, below them, in nested
 * `properties` and typed-array `items`, never inside a `refersTo`, an `enum` or
 * any other keyword's value. A shorthand beside its long-form keywords, an
 * identifier with a `size`, or a `bytes` without one is refused by the node
 * (full validation); here it is left as written, for the parse to refuse.
 */

const IDENTIFIER_MEDIA_TYPE = 'application/x.dash.dpp.identifier';
const LONG_FORM_KEYWORDS = ['byteArray', 'minItems', 'maxItems', 'contentMediaType'];

/** The long form of one property schema, or the schema itself when it declares no shorthand. */
function expandProperty(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out = { ...schema };
  const shorthand = out.type === 'identifier' || out.type === 'bytes';
  if (shorthand && !LONG_FORM_KEYWORDS.some((keyword) => keyword in out)) {
    const size = out.type === 'identifier' ? (out.size === undefined ? 32 : null) : out.size;
    if (Number.isInteger(size) && size >= 1) {
      const identifier = out.type === 'identifier';
      delete out.type;
      delete out.size;
      Object.assign(out, { type: 'array', byteArray: true, minItems: size, maxItems: size }, identifier ? { contentMediaType: IDENTIFIER_MEDIA_TYPE } : {});
    }
  }
  if (out.properties && typeof out.properties === 'object') out.properties = expandMembers(out.properties);
  if (out.items && typeof out.items === 'object' && !Array.isArray(out.items)) out.items = expandProperty(out.items);
  return out;
}

const expandMembers = (members) => Object.fromEntries(Object.entries(members).map(([name, schema]) => [name, expandProperty(schema)]));

/** A document type schema with every property type shorthand written in full (a copy; the input is not changed). */
export function expandShorthands(documentSchema) {
  if (!documentSchema || typeof documentSchema !== 'object') return documentSchema;
  const out = { ...documentSchema };
  if (out.properties && typeof out.properties === 'object') out.properties = expandMembers(out.properties);
  if (out.$defs && typeof out.$defs === 'object') out.$defs = expandMembers(out.$defs);
  return out;
}

/** Every document type of `documentSchemas` with its shorthands written in full. */
export function expandSchemas(documentSchemas) {
  return Object.fromEntries(Object.entries(documentSchemas).map(([name, schema]) => [name, expandShorthands(schema)]));
}
