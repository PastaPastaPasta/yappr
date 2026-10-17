/**
 * A pure TypeScript port of the index selection Drive runs at platform
 * v5.0.0-rc.3 (protocol version 14), for the query → index conformance spec.
 * Given a data contract's JSON and a client request shape it answers whether
 * Drive would serve the request, through which index, or why it refuses it.
 *
 * Every rule cites the source it ports, as `<file>:<lines>` at tag
 * v5.0.0-rc.3 of dashpay/platform (read with
 * `git -C ~/workspace/platform show v5.0.0-rc.3:<file>`). Short names:
 *
 *   index.rs     packages/rs-dpp/src/data_contract/document_type/index/mod.rs
 *   schema.rs    packages/rs-dpp/src/data_contract/document_type/class_methods/try_from_schema/common/mod.rs
 *   methods.rs   packages/rs-dpp/src/data_contract/document_type/methods/versioned_methods.rs
 *   query.rs     packages/rs-drive/src/query/mod.rs
 *   grouping.rs  packages/rs-drive/src/query/where_clause_grouping/v1/mod.rs
 *   conditions.rs packages/rs-drive/src/query/conditions.rs
 *   single_in.rs packages/rs-drive/src/query/non_primary_key_path_query/single_in_path_query/v0/mod.rs
 *   multi_in.rs  packages/rs-drive/src/query/non_primary_key_path_query/multiple_in_path_query/v0/mod.rs
 *   terminal.rs  packages/rs-drive/src/query/index_only_synthesis.rs
 *   canon.rs     packages/rs-drive/src/query/canonicalize.rs
 *   count.rs     packages/rs-drive/src/query/drive_document_count_query/mod.rs
 *   count_pick.rs packages/rs-drive/src/query/drive_document_count_query/index_picker.rs
 *   count_mode.rs packages/rs-drive/src/query/drive_document_count_query/mode_detection.rs
 *   count_lookup.rs packages/rs-drive/src/query/drive_document_count_query/executors/point_lookup_proof.rs
 *   agg_mode.rs  packages/rs-drive-abci/src/query/document_query/v1/compute_aggregate_mode_and_check_limit/v{0,1,2}/mod.rs
 *   ranked_pick.rs packages/rs-drive/src/query/drive_document_ranked_query/index_picker.rs
 *   ranked_mode.rs packages/rs-drive/src/query/drive_document_ranked_query/mode_detection/v0/mod.rs
 *   sum_pick.rs  packages/rs-drive/src/query/drive_document_sum_query/index_picker.rs
 *   avg.rs       packages/rs-drive/src/query/drive_document_average_query/drive_dispatcher.rs
 *   composite.rs packages/rs-drive/src/query/composite_document_query/mod.rs
 *
 * Covered: documents queries (primary-key reads, the single- and multi-`in`
 * generic matcher with the contiguous-prefix rule, the indexOnly terminal
 * route and its pivot rules, `skipIfAbsent` and typed-array admissibility,
 * time-range bucket provenance, the orderBy-per-fan-out rule), proved counts
 * (total, per-`in`, range, range-distinct, carrier), ranked reads, point
 * (no-range) averages, and composite sub-queries (by-id joins, lookups,
 * siblings, bound counts). Not covered: integerRange selections, having
 * reads, sums, range averages, chained queries, and limit/cursor arithmetic
 * beyond the indexOnly pivot rule. An unmodeled shape is reported as
 * unservable with a reason that says so, never passed.
 */

/** Drive's `MAX_INDEX_DIFFERENCE` (packages/rs-drive/src/query/defaults.rs:2). */
const MAX_INDEX_DIFFERENCE = 2

/** The default documents-query limit a request without one runs with (rs-drive config). */
const DEFAULT_QUERY_LIMIT = 100

/** `MAX_RANKED_LIMIT` and `MAX_PREFIX_IN_BRANCHES` (packages/rs-drive/src/query/drive_document_ranked_query/mod.rs:142, 156). */
const MAX_RANKED_LIMIT = 100
const MAX_PREFIX_IN_BRANCHES = 10

/** `MAX_SUB_QUERIES` and `MAX_BOUND_VALUES` (composite.rs:135, 140). */
const MAX_SUB_QUERIES = 10
const MAX_BOUND_VALUES = 100

// ---------------------------------------------------------------------------
// Contract model
// ---------------------------------------------------------------------------

export interface IndexProperty {
  name: string
  ascending: boolean
}

/** A `timeRange` / `integerRange` grid (index.rs:1344-1372). */
export interface IndexBucketing {
  kind: 'time' | 'integer'
  source: string
  range: number
  step: number
  phase: number
}

export interface ModelIndex {
  name: string
  properties: IndexProperty[]
  unique: boolean
  /** An indexOnly index's member-key components; null on a regular index. */
  terminal: string[] | null
  countable: boolean
  rangeCountable: boolean
  rankedCountable: boolean
  rankedCountableAt: string[]
  summable: string | null
  summableOffCountIndex: string | null
  rangeSummable: boolean
  rankedSummable: boolean
  rankedSummableAt: string[]
  rankedAverageable: boolean
  rankedAverageableAt: string[]
  skipIfAbsent: boolean
  skipIfAbsentProperties: string[]
  indexedArray: string | null
  bucketing: IndexBucketing | null
}

export interface ModelDocumentType {
  name: string
  /** In `BTreeMap<String, Index>` order (by name), the order every Drive picker walks. */
  indexes: ModelIndex[]
  indexOnly: boolean
  documentsCountable: boolean
  documentsSummable: string | null
  typedArrays: ReadonlySet<string>
  /** Properties whose schema pins one value (`const`), such as v17's `live` marker. */
  constProperties: ReadonlySet<string>
}

export type ModelContract = ReadonlyMap<string, ModelDocumentType>

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Byte-order (BTreeMap) comparison of ASCII index names. */
function byName(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1
  return a.name > b.name ? 1 : 0
}

/**
 * A ranking keyword resolved against the property list: `true`/`false`, or
 * `{ at: name | names }`, where naming the last property folds into the
 * boolean and the levels sort into property order (index.rs:2786-2800).
 */
function resolveRanking(value: unknown, properties: IndexProperty[]): { ranked: boolean; at: string[] } {
  if (value === true) return { ranked: true, at: [] }
  if (!isObject(value)) return { ranked: false, at: [] }
  const levels = Array.isArray(value.at) ? value.at.map(String) : [String(value.at)]
  const last = properties[properties.length - 1]?.name
  const position = (name: string) => properties.findIndex((property) => property.name === name)
  return {
    ranked: levels.includes(last),
    at: levels.filter((level) => level !== last).sort((a, b) => position(a) - position(b)),
  }
}

/**
 * A typed array: an array property with element items and no byteArray, the
 * `DocumentPropertyType::TypedArray` of rs-dpp property/mod.rs:247-255.
 */
function typedArrayNames(properties: JsonObject): Set<string> {
  const names = new Set<string>()
  for (const [name, schema] of Object.entries(properties)) {
    if (isObject(schema) && schema.type === 'array' && schema.byteArray !== true && isObject(schema.items)) {
      names.add(name)
    }
  }
  return names
}

function parseIndex(raw: JsonObject, required: ReadonlySet<string>, typedArrays: ReadonlySet<string>): ModelIndex {
  const properties: IndexProperty[] = (Array.isArray(raw.properties) ? raw.properties : []).map((entry) => {
    const [name, direction] = Object.entries(entry as JsonObject)[0]
    return { name, ascending: direction !== 'desc' }
  })
  const countableValue = raw.countable
  const averageable = typeof raw.averageable === 'string' ? raw.averageable : null
  const rangeAverageable = raw.rangeAverageable === true
  const rangeCountable = raw.rangeCountable === true || rangeAverageable
  // `averageable` and `rangeCountable` both imply countable (index.rs:2885-2970).
  const countable =
    countableValue === true || countableValue === 'countable' || countableValue === 'countableAllowingOffset' ||
    averageable !== null || rangeCountable
  const summableOffCountIndex = typeof raw.summableOffCountIndex === 'string' ? raw.summableOffCountIndex : null
  let rankedCount = resolveRanking(raw.rankedCountable, properties)
  let rankedSum = resolveRanking(raw.rankedSummable, properties)
  const rankedAvg = resolveRanking(raw.rankedAverageable, properties)
  if (summableOffCountIndex !== null) {
    // A summableOffCountIndex index's count ranking is its sum ranking: the
    // count levels merge into the Sum axis (index.rs:2838-2858).
    const at = [...rankedSum.at, ...rankedCount.at.filter((level) => !rankedSum.at.includes(level))]
    const position = (name: string) => properties.findIndex((property) => property.name === name)
    rankedSum = { ranked: rankedSum.ranked || rankedCount.ranked, at: at.sort((a, b) => position(a) - position(b)) }
    rankedCount = { ranked: false, at: [] }
  }

  // `skipIfAbsent: true` skips on every optional, non-system property not
  // read through a reference; the array form names its set (index.rs:2650-2785,
  // schema.rs:1002-1024). An indexed typed array is always in the skip set,
  // and `indexedArray` names it (schema.rs:1026-1055).
  const skipIfAbsent = raw.skipIfAbsent === true || Array.isArray(raw.skipIfAbsent)
  let skipIfAbsentProperties: string[] = Array.isArray(raw.skipIfAbsent)
    ? properties.map((property) => property.name).filter((name) => (raw.skipIfAbsent as unknown[]).includes(name))
    : raw.skipIfAbsent === true
      ? properties
        .map((property) => property.name)
        .filter((name) => !name.startsWith('$') && !required.has(name) && !name.includes('.'))
      : []
  const indexedArray = properties.find((property) => typedArrays.has(property.name))?.name ?? null
  if (indexedArray !== null) {
    const declared = skipIfAbsentProperties
    skipIfAbsentProperties = properties
      .map((property) => property.name)
      .filter((name) => declared.includes(name) || name === indexedArray)
  }

  const terminal = typeof raw.terminal === 'string' ? [raw.terminal] : Array.isArray(raw.terminal) ? raw.terminal.map(String) : null
  const bucketingOf = (kind: 'time' | 'integer', value: unknown): IndexBucketing | null =>
    isObject(value)
      ? { kind, source: String(value.on), range: Number(value.range), step: Number(value.step), phase: Number(value.phase ?? 0) }
      : null

  return {
    name: String(raw.name),
    properties,
    unique: raw.unique === true,
    terminal,
    countable,
    rangeCountable,
    rankedCountable: rankedCount.ranked,
    rankedCountableAt: rankedCount.at,
    summable: typeof raw.summable === 'string' ? raw.summable : averageable,
    summableOffCountIndex,
    rangeSummable: raw.rangeSummable === true || rangeAverageable,
    rankedSummable: rankedSum.ranked,
    rankedSummableAt: rankedSum.at,
    rankedAverageable: rankedAvg.ranked,
    rankedAverageableAt: rankedAvg.at,
    skipIfAbsent,
    skipIfAbsentProperties,
    indexedArray,
    bucketing: bucketingOf('time', raw.timeRange) ?? bucketingOf('integer', raw.integerRange),
  }
}

/**
 * Parse a contract JSON: `{ documentSchemas: {...} }`, `{ documents: {...} }`
 * or a bare map of document schemas (the blocks contract file).
 */
export function parseContract(json: unknown): ModelContract {
  const root = isObject(json) ? json : {}
  const schemas = isObject(root.documentSchemas) ? root.documentSchemas : isObject(root.documents) ? root.documents : root
  const types = new Map<string, ModelDocumentType>()
  for (const [name, schema] of Object.entries(schemas)) {
    if (!isObject(schema) || !isObject(schema.properties)) continue
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
    const typedArrays = typedArrayNames(schema.properties)
    const averageable = typeof schema.documentsAverageable === 'string' ? schema.documentsAverageable : null
    types.set(name, {
      name,
      indexes: (Array.isArray(schema.indices) ? schema.indices : [])
        .filter(isObject)
        .map((index) => parseIndex(index, required, typedArrays))
        .sort(byName),
      indexOnly: schema.indexOnly === true,
      // A doctype-level `rangeCountable` implies `documentsCountable` (schema.rs:2370).
      documentsCountable: schema.documentsCountable === true || schema.rangeCountable === true || averageable !== null,
      documentsSummable: typeof schema.documentsSummable === 'string' ? schema.documentsSummable : averageable,
      typedArrays,
      constProperties: new Set(
        Object.entries(schema.properties).filter(([, property]) => isObject(property) && 'const' in property).map(([name]) => name),
      ),
    })
  }
  return types
}

// ---------------------------------------------------------------------------
// Requests and verdicts
// ---------------------------------------------------------------------------

export type WhereTuple = readonly [string, string, unknown]
export type OrderTuple = readonly [string, string]

export interface TimeRangeSelection {
  field: string
  selector?: string
  startMs?: number
  grid?: { range: number; step: number; phase?: number }
}

export interface DocumentsRequest {
  where?: readonly WhereTuple[]
  orderBy?: readonly OrderTuple[]
  limit?: number
  startAt?: unknown
  startAfter?: unknown
  timeRange?: readonly TimeRangeSelection[]
}

export interface CountRequest {
  where?: readonly WhereTuple[]
  orderBy?: readonly OrderTuple[]
  groupBy?: readonly string[]
  limit?: number
  timeRange?: readonly TimeRangeSelection[]
}

export interface RankedRequest {
  groupBy: string
  limit?: number
  aggregate: { type: 'count' } | { type: 'sum' | 'avg'; property: string }
  where?: readonly WhereTuple[]
  timeRange?: readonly TimeRangeSelection[]
}

export interface AverageRequest {
  where?: readonly WhereTuple[]
  groupBy?: readonly string[]
  sumProperty: string
}

export type Verdict =
  | { servable: true; route: string; index: string | null }
  | { servable: false; reason: string; closestIndex: string | null }

/** A refusal Drive would answer the request with; caught at each entry point. */
class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message)
}

function served(route: string, index: ModelIndex | null): Verdict {
  return { servable: true, route, index: index ? describeIndex(index) : null }
}

export function describeIndex(index: ModelIndex): string {
  const properties = index.properties.map((property) => property.name).join(', ')
  const terminal = index.terminal ? ` terminal ${index.terminal.join('+')}` : ''
  return `${index.name} [${properties}]${terminal}`
}

/**
 * The indexes naming the most of `fields`, with the properties each leaves
 * unbound before the last one it names counted against it (a single-valued
 * `const` property, such as `live`, only lightly: pinning it changes no
 * result), among the bucketed indexes when the request selects a window and
 * the raw ones otherwise; equally close ones are all named. For failure
 * messages only; Drive has no such notion.
 */
function closestIndex(type: ModelDocumentType, fields: readonly string[], windowed: boolean): string | null {
  const scored = type.indexes
    .filter((index) => (index.bucketing !== null) === windowed)
    .map((index) => {
      const names = [...index.properties.map((property) => property.name), ...(index.terminal ?? [])]
      const used = names.filter((name) => fields.includes(name)).length
      const lastUsed = names.reduce((last, name, position) => (fields.includes(name) ? position : last), -1)
      const gaps = names.slice(0, lastUsed + 1).filter((name) => !fields.includes(name))
      const gapCost = gaps.reduce((cost, name) => cost + (type.constProperties.has(name) ? 1 : 3), 0)
      return { index, score: used * 10 - gapCost - (names.length - used) }
    })
  const best = Math.max(0, ...scored.map((entry) => entry.score))
  const closest = scored.filter((entry) => entry.score === best && best > 0).slice(0, 3)
  return closest.length === 0 ? null : closest.map((entry) => describeIndex(entry.index)).join(' or ')
}

function evaluate(type: ModelDocumentType, fields: readonly string[], windowed: boolean, run: () => Verdict): Verdict {
  try {
    return run()
  } catch (error) {
    if (error instanceof Refusal) {
      return { servable: false, reason: error.message, closestIndex: closestIndex(type, fields, windowed) }
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Where clauses
// ---------------------------------------------------------------------------

type Operator =
  | 'equal' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'between' | 'betweenExcludeBounds' | 'betweenExcludeLeft' | 'betweenExcludeRight'
  | 'in' | 'startsWith' | 'contains' | 'containsAny'

interface WhereClause {
  field: string
  operator: Operator
  value: unknown
}

/** `WhereOperator::from_string` (conditions.rs:179-205). */
function parseOperator(text: string): Operator {
  const operators: Record<string, Operator> = {
    '=': 'equal', '==': 'equal', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
    Between: 'between', between: 'between',
    BetweenExcludeBounds: 'betweenExcludeBounds', betweenExcludeBounds: 'betweenExcludeBounds',
    betweenexcludebounds: 'betweenExcludeBounds', between_exclude_bounds: 'betweenExcludeBounds',
    BetweenExcludeLeft: 'betweenExcludeLeft', betweenExcludeLeft: 'betweenExcludeLeft',
    betweenexcludeleft: 'betweenExcludeLeft', between_exclude_left: 'betweenExcludeLeft',
    BetweenExcludeRight: 'betweenExcludeRight', betweenExcludeRight: 'betweenExcludeRight',
    betweenexcluderight: 'betweenExcludeRight', between_exclude_right: 'betweenExcludeRight',
    In: 'in', in: 'in',
    StartsWith: 'startsWith', startsWith: 'startsWith', startswith: 'startsWith', starts_with: 'startsWith',
    Contains: 'contains', contains: 'contains',
    ContainsAny: 'containsAny', containsAny: 'containsAny', containsany: 'containsAny', contains_any: 'containsAny',
  }
  const operator = operators[text]
  if (!operator) refuse(`unknown where operator "${text}"`)
  return operator
}

function parseWhere(where: readonly WhereTuple[] | undefined): WhereClause[] {
  return (where ?? []).map(([field, operator, value]) => ({ field, operator: parseOperator(operator), value }))
}

/** `WhereOperator::is_range` (conditions.rs:153-160): `in` fans out like a range. */
function fansOut(operator: Operator): boolean {
  return operator !== 'equal' && operator !== 'contains'
}

/** The count surface's range operators (count_mode.rs `is_range_operator`). */
function isRangeOperator(operator: Operator): boolean {
  return ['gt', 'gte', 'lt', 'lte', 'between', 'betweenExcludeBounds', 'betweenExcludeLeft',
    'betweenExcludeRight', 'startsWith'].includes(operator)
}

/** Whether `value` may encode to the empty key a missing value takes (query.rs:1341-1349). */
function mayEncodeAsMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (value instanceof Uint8Array) return value.length === 0
  if (Array.isArray(value)) return value.length === 0
  return typeof value === 'string' && value.length === 0
}

interface SkipBinding {
  field: string
  excludesMissing: boolean
  constrains: boolean
}

/** `SkipIfAbsentBinding::for_where_clause` (query.rs:1289-1327). */
function bindingFor(clause: WhereClause): SkipBinding {
  const lowerBoundExcludesMissing = () => Array.isArray(clause.value) && clause.value.length > 0 && !mayEncodeAsMissing(clause.value[0])
  const excludesMissing = (() => {
    switch (clause.operator) {
      case 'equal':
      case 'gte':
        return !mayEncodeAsMissing(clause.value)
      case 'in':
        return Array.isArray(clause.value) && clause.value.every((value) => !mayEncodeAsMissing(value))
      case 'gt':
      case 'betweenExcludeBounds':
      case 'betweenExcludeLeft':
      case 'contains':
      case 'containsAny':
        return true
      case 'between':
      case 'betweenExcludeRight':
        return lowerBoundExcludesMissing()
      case 'startsWith':
        return typeof clause.value === 'string' && clause.value.length > 0
      default:
        return false
    }
  })()
  return { field: clause.field, excludesMissing, constrains: true }
}

/** The clauses grouped by role, Drive's `InternalClauses` (query.rs:442-560). */
interface InternalClauses {
  primaryKeyEqual: WhereClause | null
  primaryKeyIn: WhereClause | null
  equal: Map<string, WhereClause>
  inClauses: WhereClause[]
  range: WhereClause | null
}

/** Pair a lower and an upper bound into the `between*` operator (grouping.rs:180-200). */
function mergeBounds(clauses: WhereClause[]): WhereClause {
  const lower = clauses.filter((clause) => clause.operator === 'gt' || clause.operator === 'gte')
  const upper = clauses.filter((clause) => clause.operator === 'lt' || clause.operator === 'lte')
  if (lower.length !== 1 || upper.length !== 1) refuse('lower and upper bounds must be passed if providing 2 ranges')
  const operator: Operator = lower[0].operator === 'gte'
    ? (upper[0].operator === 'lte' ? 'between' : 'betweenExcludeRight')
    : (upper[0].operator === 'lte' ? 'betweenExcludeLeft' : 'betweenExcludeBounds')
  return { field: lower[0].field, operator, value: [lower[0].value, upper[0].value] }
}

/**
 * `group_where_clauses_v1` (grouping.rs:30-246) plus the primary-key split
 * and `verify` of `InternalClauses::extract_from_clauses` (query.rs:557-631,
 * 523-539): `contains` groups as an equality, `containsAny` as an `in`.
 */
function groupClauses(clauses: WhereClause[]): InternalClauses {
  const isId = (clause: WhereClause) => clause.field === '$id'
  const primaryEqual = clauses.filter((clause) => clause.operator === 'equal' && isId(clause))
  const primaryIn = clauses.filter((clause) => clause.operator === 'in' && isId(clause))
  if (primaryEqual.length > 1) refuse('There should only be one equal clause for the primary key')
  if (primaryIn.length > 1) refuse('There should only be one in clause for the primary key')

  const known = new Set<string>()
  const equal = new Map<string, WhereClause>()
  for (const clause of clauses) {
    if ((clause.operator === 'equal' && !isId(clause)) || clause.operator === 'contains') {
      if (known.has(clause.field)) refuse(`duplicate equality fields ("${clause.field}")`)
      known.add(clause.field)
      equal.set(clause.field, clause)
    }
  }
  const inClauses: WhereClause[] = []
  for (const clause of clauses) {
    if ((clause.operator === 'in' && !isId(clause)) || clause.operator === 'containsAny') {
      if (known.has(clause.field)) refuse(`in clause has same field as an equality or in clause ("${clause.field}")`)
      known.add(clause.field)
      inClauses.push(clause)
    }
  }
  const groupable = clauses.filter((clause) => ['gt', 'gte', 'lt', 'lte'].includes(clause.operator))
  const nonGroupable = clauses.filter((clause) =>
    ['startsWith', 'between', 'betweenExcludeBounds', 'betweenExcludeLeft', 'betweenExcludeRight'].includes(clause.operator))
  let range: WhereClause | null = null
  if (nonGroupable.length === 0) {
    if (groupable.length > 2) refuse('there can only be at most 2 range clauses that must be on the same field')
    if (groupable.length > 0) {
      if (known.has(groupable[0].field)) refuse('a range clause has same field as an equality or in clause')
      if (groupable.some((clause) => clause.field !== groupable[0].field)) refuse('all ranges must be on same field')
      range = groupable.length === 1 ? groupable[0] : mergeBounds(groupable)
    }
  } else if (nonGroupable.length === 1 && groupable.length === 0) {
    const clause = nonGroupable[0]
    if (clause.operator === 'startsWith' && clause.value === '') refuse('starts with can not start with an empty string')
    if (known.has(clause.field)) refuse('a non groupable range clause has same field as an equality or in clause')
    range = clause
  } else {
    refuse('there can not be more than 1 non groupable range clause, nor a mix with groupable ones')
  }

  const grouped: InternalClauses = {
    primaryKeyEqual: primaryEqual[0] ?? null,
    primaryKeyIn: primaryIn[0] ?? null,
    equal,
    inClauses,
    range,
  }
  const hasPrimaryKey = grouped.primaryKeyEqual !== null || grouped.primaryKeyIn !== null
  if (hasPrimaryKey && (equal.size > 0 || inClauses.length > 0 || range !== null)) {
    refuse('Query has invalid where clauses: a primary-key ($id) clause stands alone')
  }
  if (grouped.primaryKeyEqual && grouped.primaryKeyIn) refuse('Query has invalid where clauses')
  return grouped
}

function allClauses(clauses: InternalClauses): WhereClause[] {
  return [...clauses.equal.values(), ...clauses.inClauses, ...(clauses.range ? [clauses.range] : [])]
}

/**
 * `validate_array_element_clause` (conditions.rs:1272-1340): a typed array is
 * read with `contains`/`containsAny` only, and those read typed arrays only.
 */
function validateArrayElementClause(type: ModelDocumentType, clause: WhereClause): void {
  const namesTypedArray = type.typedArrays.has(clause.field)
  const readsElements = clause.operator === 'contains' || clause.operator === 'containsAny'
  if (namesTypedArray && !readsElements) {
    refuse(`"${clause.field}" is a typed array: it is read with contains or containsAny, and no other operator`)
  }
  if (!namesTypedArray && readsElements) {
    refuse(`contains and containsAny read the elements of a typed array; "${clause.field}" is not one`)
  }
}

interface ResolvedRange {
  grid: IndexBucketing
}

/**
 * `resolve_time_range_bucket_clause` / `select_selection_grid`
 * (query.rs:919-965, 1014-1110): the selection becomes an equality on the
 * bucketed field, recorded with the grid it resolved against.
 */
function resolveTimeRanges(
  type: ModelDocumentType,
  selections: readonly TimeRangeSelection[] | undefined,
): { clauses: WhereClause[]; resolved: ResolvedRange[] } {
  const clauses: WhereClause[] = []
  const resolved: ResolvedRange[] = []
  for (const selection of selections ?? []) {
    const grids: IndexBucketing[] = []
    for (const index of type.indexes) {
      const grid = index.bucketing
      if (grid?.kind === 'time' && grid.source === selection.field && !grids.some((known) => sameGrid(known, grid))) {
        grids.push(grid)
      }
    }
    if (grids.length === 0) refuse(`no time-range index is defined on field "${selection.field}"`)
    let grid: IndexBucketing
    if (selection.grid) {
      const spec = selection.grid
      const named = grids.find((candidate) =>
        candidate.range === spec.range && candidate.step === spec.step && candidate.phase === (spec.phase ?? 0))
      if (!named) refuse(`no time-range index on "${selection.field}" declares the grid ${JSON.stringify(spec)}`)
      grid = named
    } else if (grids.length > 1) {
      refuse(`field "${selection.field}" is bucketed by ${grids.length} different time-range grids; the selection must name one`)
    } else {
      grid = grids[0]
    }
    clauses.push({ field: selection.field, operator: 'equal', value: selection.startMs ?? 1 })
    resolved.push({ grid })
  }
  // At most one window selection per query (query.rs:3381-3392).
  if (resolved.length > 1) refuse('at most one window selection (IN_TIME_RANGE or IN_INTEGER_RANGE) is supported per query')
  return { clauses, resolved }
}

function sameGrid(a: IndexBucketing, b: IndexBucketing): boolean {
  return a.kind === b.kind && a.source === b.source && a.range === b.range && a.step === b.step && a.phase === b.phase
}

// ---------------------------------------------------------------------------
// Admissibility
// ---------------------------------------------------------------------------

/** `index_admissible_for_resolved_time_range` (query.rs:1236-1255). */
function admissibleForResolvedTimeRange(index: ModelIndex, resolved: ResolvedRange[]): boolean {
  if (resolved.length === 0) return index.bucketing === null
  if (resolved.length === 1) return index.bucketing !== null && sameGrid(index.bucketing, resolved[0].grid)
  return false
}

/** `index_admissible_for_skip_if_absent` (query.rs:1379-1411). */
function admissibleForSkipIfAbsent(index: ModelIndex, bindings: SkipBinding[]): boolean {
  const arrayBound = (array: string) => bindings.some((binding) => binding.field === array && binding.constrains)
  if (!index.skipIfAbsent) return index.indexedArray === null || arrayBound(index.indexedArray)
  const indexOnly = isIndexOnlyIndex(index)
  return index.skipIfAbsentProperties.every((skipProperty) => {
    if (index.indexedArray === skipProperty) return arrayBound(skipProperty)
    return bindings.some((binding) => binding.field === skipProperty && (indexOnly || binding.excludesMissing))
  })
}

/** `Index::is_index_only` (index.rs:1540-1542). */
function isIndexOnlyIndex(index: ModelIndex): boolean {
  return index.terminal !== null || index.summableOffCountIndex !== null
}

/** `index_admissible_for_query` (query.rs:1422-1430). */
function admissibleForQuery(index: ModelIndex, resolved: ResolvedRange[], bindings: SkipBinding[]): boolean {
  return admissibleForResolvedTimeRange(index, resolved) && admissibleForSkipIfAbsent(index, bindings)
}

/** `document_index_admissible_for_query` (query.rs:1440-1448): counters keep no entries. */
function documentAdmissibleForQuery(index: ModelIndex, resolved: ResolvedRange[], bindings: SkipBinding[]): boolean {
  return index.summableOffCountIndex === null && admissibleForQuery(index, resolved, bindings)
}

// ---------------------------------------------------------------------------
// The matcher (rs-dpp Index::matches_*)
// ---------------------------------------------------------------------------

/** `Index::matches_over_components` (index.rs:1755-1840), the v0 rule. */
export function matchesOverComponents(
  properties: readonly IndexProperty[],
  indexNames: readonly string[],
  inFieldName: string | null,
  orderBy: readonly string[],
): number | null {
  if (properties.length === 0) {
    return indexNames.length === 0 && inFieldName === null && orderBy.length === 0 ? 0 : null
  }
  let reduced = properties.slice()
  if (orderBy.length > 0) {
    for (let step = 0; step < properties.length; step++) {
      if (reduced.length < orderBy.length) return null
      const tail = reduced.slice(reduced.length - orderBy.length)
      if (tail.every((property, position) => property.name === orderBy[position])) break
      if (reduced.length === 0) return null
      reduced = reduced.slice(0, -1)
    }
  }
  const last = properties[properties.length - 1]
  if (inFieldName !== null && last.name !== inFieldName) {
    if (properties.length === 1) return null
    if (properties[properties.length - 2].name !== inFieldName) return null
  }
  let difference = properties.length
  for (const name of indexNames) {
    if (!reduced.some((property) => property.name === name)) return null
    difference -= 1
  }
  return difference
}

/** `Index::matches_over_components_contiguous` (index.rs:1918-2005), protocol version 14. */
export function matchesOverComponentsContiguous(
  properties: readonly IndexProperty[],
  equalityFields: readonly string[],
  rangeField: string | null,
  inFieldName: string | null,
  orderBy: readonly string[],
): number | null {
  const indexNames = [...equalityFields]
  for (const field of [rangeField, inFieldName, ...orderBy]) {
    if (field !== null && !indexNames.includes(field)) indexNames.push(field)
  }
  const difference = matchesOverComponents(properties, indexNames, inFieldName, orderBy)
  if (difference === null) return null
  if (properties.length < equalityFields.length) return null
  if (!properties.slice(0, equalityFields.length).every((property) => equalityFields.includes(property.name))) return null
  const positionOf = (field: string) => properties.findIndex((property) => property.name === field)
  const equalityLength = equalityFields.length
  if (rangeField !== null && inFieldName !== null) {
    const rangePosition = positionOf(rangeField)
    const inPosition = positionOf(inFieldName)
    if (rangePosition < 0 || inPosition < 0) return null
    if (Math.min(rangePosition, inPosition) !== equalityLength || Math.max(rangePosition, inPosition) !== equalityLength + 1) {
      return null
    }
  } else if (rangeField !== null || inFieldName !== null) {
    if (positionOf((rangeField ?? inFieldName) as string) !== equalityLength) return null
  }
  if (properties.length < indexNames.length) return null
  if (!properties.slice(0, indexNames.length).every((property) => indexNames.includes(property.name))) return null
  return difference
}

/** `follows_component_order` (index.rs:696-705). */
function followsComponentOrder(components: readonly string[], fields: readonly string[]): boolean {
  for (let position = 1; position < fields.length; position++) {
    const earlier = components.indexOf(fields[position - 1])
    const later = components.indexOf(fields[position])
    if (earlier < 0 || later < 0 || earlier >= later) return false
  }
  return true
}

/** `Index::matches_including_terminal_contiguous` (index.rs:1869-1916). */
export function matchesIncludingTerminalContiguous(
  index: ModelIndex,
  equalityFields: readonly string[],
  rangeField: string | null,
  inFieldName: string | null,
  orderBy: readonly string[],
): { difference: number; terminalUsed: boolean } | null {
  const components = index.terminal
  if (components === null) {
    const difference = matchesOverComponentsContiguous(index.properties, equalityFields, rangeField, inFieldName, orderBy)
    return difference === null ? null : { difference, terminalUsed: false }
  }
  const isComponent = (field: string) => components.includes(field)
  const terminalUsed = equalityFields.some(isComponent) ||
    (rangeField !== null && isComponent(rangeField)) ||
    (inFieldName !== null && isComponent(inFieldName)) ||
    orderBy.some(isComponent)
  const position = orderBy.findIndex(isComponent)
  let prefixOrderBy = orderBy
  if (position >= 0) {
    const trailing = orderBy.slice(position)
    if (!trailing.every(isComponent) || !followsComponentOrder(components, trailing)) return null
    prefixOrderBy = orderBy.slice(0, position)
  }
  const difference = matchesOverComponentsContiguous(
    index.properties,
    equalityFields.filter((field) => !isComponent(field)),
    rangeField !== null && !isComponent(rangeField) ? rangeField : null,
    inFieldName !== null && !isComponent(inFieldName) ? inFieldName : null,
    prefixOrderBy,
  )
  return difference === null ? null : { difference, terminalUsed }
}

interface MatchInput {
  equalityFields: string[]
  rangeField: string | null
  inField: string | null
  orderBy: string[]
}

/** `index_for_types_matching_v1` (methods.rs:548-575): best (lowest) difference, first by name on ties. */
function indexForTypesMatching(
  type: ModelDocumentType,
  input: MatchInput,
  filter: (index: ModelIndex) => boolean,
): { index: ModelIndex; difference: number } | null {
  let best: { index: ModelIndex; difference: number } | null = null
  for (const index of type.indexes) {
    if (!filter(index)) continue
    const difference = matchesOverComponentsContiguous(index.properties, input.equalityFields, input.rangeField, input.inField, input.orderBy)
    if (difference === null) continue
    if (difference === 0) return { index, difference }
    if (!best || difference < best.difference) best = { index, difference }
  }
  return best
}

/**
 * `index_for_types_matching_including_terminal_v1` (methods.rs:582-628):
 * a generic cover keeps absolute precedence over a terminal-using one.
 */
function indexForTypesMatchingIncludingTerminal(
  type: ModelDocumentType,
  input: MatchInput,
  filter: (index: ModelIndex) => boolean,
): { index: ModelIndex; difference: number; terminalUsed: boolean } | null {
  let bestGeneric: { index: ModelIndex; difference: number } | null = null
  let bestTerminal: { index: ModelIndex; difference: number } | null = null
  for (const index of type.indexes) {
    if (!filter(index)) continue
    const matched = matchesIncludingTerminalContiguous(index, input.equalityFields, input.rangeField, input.inField, input.orderBy)
    if (!matched) continue
    if (matched.terminalUsed) {
      if (!bestTerminal || matched.difference < bestTerminal.difference) bestTerminal = { index, difference: matched.difference }
    } else {
      if (matched.difference === 0) return { index, difference: 0, terminalUsed: false }
      if (!bestGeneric || matched.difference < bestGeneric.difference) bestGeneric = { index, difference: matched.difference }
    }
  }
  if (bestGeneric) return { ...bestGeneric, terminalUsed: false }
  return bestTerminal ? { ...bestTerminal, terminalUsed: true } : null
}

// ---------------------------------------------------------------------------
// Documents queries
// ---------------------------------------------------------------------------

interface OrderClause {
  field: string
  ascending: boolean
}

/** Order clauses keyed by field, first spelling's position kept (Drive's `IndexMap`). */
function parseOrderBy(orderBy: readonly OrderTuple[] | undefined): OrderClause[] {
  const clauses: OrderClause[] = []
  for (const [field, direction] of orderBy ?? []) {
    const existing = clauses.find((clause) => clause.field === field)
    if (existing) existing.ascending = direction !== 'desc'
    else clauses.push({ field, ascending: direction !== 'desc' })
  }
  return clauses
}

function requestFields(where: readonly WhereTuple[] | undefined, orderBy: readonly OrderTuple[] | undefined): string[] {
  return [...(where ?? []).map(([field]) => field), ...(orderBy ?? []).map(([field]) => field)]
}

/** Whether a documents request on `type` is served, and by which index. */
export function checkDocumentsQuery(type: ModelDocumentType, request: DocumentsRequest): Verdict {
  return evaluate(type, requestFields(request.where, request.orderBy), Boolean(request.timeRange?.length), () => documentsQuery(type, request))
}

/** `WhereClause::in_values` (conditions.rs:399-433): 1..100 distinct values. */
function validateInValues(clause: WhereClause): void {
  const values = clause.value instanceof Uint8Array ? Array.from(clause.value) : clause.value
  if (!Array.isArray(values)) refuse(`the in clause on "${clause.field}" must provide an array of values`)
  if (values.length === 0) refuse(`the in clause on "${clause.field}" must have at least 1 value`)
  if (values.length > 100) refuse(`the in clause on "${clause.field}" must have at most 100 values`)
  const keys = values.map((value) => JSON.stringify(value, (_key, item: unknown) => (item instanceof Uint8Array ? Array.from(item) : item)))
  if (new Set(keys).size !== keys.length) refuse(`the in clause on "${clause.field}" repeats a value`)
}

function documentsQuery(type: ModelDocumentType, request: DocumentsRequest): Verdict {
  const { clauses: resolvedClauses, resolved } = resolveTimeRanges(type, request.timeRange)
  const clauses = groupClauses([...parseWhere(request.where), ...resolvedClauses])
  const orderBy = parseOrderBy(request.orderBy)
  const hasCursor = request.startAt !== undefined || request.startAfter !== undefined
  // A limit of 0 or above the default query limit is InvalidLimit (query.rs:2277-2287).
  if (request.limit !== undefined && (request.limit < 1 || request.limit > DEFAULT_QUERY_LIMIT)) {
    refuse(`limit ${request.limit} is outside 1..${DEFAULT_QUERY_LIMIT}`)
  }
  for (const clause of [...clauses.inClauses, ...(clauses.primaryKeyIn ? [clauses.primaryKeyIn] : [])]) validateInValues(clause)

  // `validate_array_element_shape` (query.rs:2607-2665).
  for (const clause of allClauses(clauses)) validateArrayElementClause(type, clause)
  const containsAny = clauses.inClauses.some((clause) => clause.operator === 'containsAny')
  if (containsAny && hasCursor) refuse('startAt/startAfter is not supported with containsAny')
  if (clauses.inClauses.length > 1 && hasCursor) refuse('startAt/startAfter is not supported with multiple in clauses')
  for (const { field } of orderBy) {
    const walked = clauses.inClauses.some((clause) => clause.field === field && clause.operator === 'containsAny')
    if (type.typedArrays.has(field) && !walked) {
      refuse(`"${field}" is a typed array: it can only be ordered by with containsAny on it`)
    }
  }

  // `validate_resolved_source_shape` (query.rs:3534-3562).
  if (resolved.length === 1) {
    const source = resolved[0].grid.source
    const rangeOrInOnSource = clauses.range?.field === source || clauses.inClauses.some((clause) => clause.field === source)
    if (!clauses.equal.has(source) || rangeOrInOnSource || orderBy.some((clause) => clause.field === source)) {
      refuse(`the index on "${source}" buckets it into time-range windows: no ranges, IN, or ordering on that property`)
    }
  }

  // `is_for_primary_key` (query.rs:1939-1953).
  const forPrimaryKey = clauses.primaryKeyEqual !== null || clauses.primaryKeyIn !== null ||
    (allClauses(clauses).length === 0 && (orderBy.length === 0 || (orderBy.length === 1 && orderBy[0].field === '$id')))

  // indexOnly types keep no primary-key tree and take no cursor (query.rs:2698-2722).
  if (type.indexOnly && forPrimaryKey) refuse('indexOnly documents cannot be fetched by id: there is no primary-key tree')
  if (type.indexOnly && hasCursor) refuse('startAt/startAfter cursors cannot address an indexOnly position')

  if (forPrimaryKey) {
    // `get_primary_key_path_query` (query.rs:3179-3220): a one-key ordering must be `$id`.
    if (clauses.primaryKeyIn && orderBy.length === 1 && orderBy[0].field !== '$id') {
      refuse('order by should include $id only')
    }
    return served('primaryKey', null)
  }

  const orderKeys = orderBy.map((clause) => clause.field)
  const bindings = [
    ...allClauses(clauses).map(bindingFor),
    ...orderKeys.map((field) => ({ field, excludesMissing: false, constrains: false })),
  ]

  if (clauses.inClauses.length > 1) return multipleInQuery(type, clauses, orderBy, resolved, bindings)

  const input: MatchInput = {
    equalityFields: [...clauses.equal.keys()].sort(),
    rangeField: clauses.range?.field ?? null,
    inField: clauses.inClauses[0]?.field ?? null,
    orderBy: orderKeys,
  }
  const admissible = (index: ModelIndex) => documentAdmissibleForQuery(index, resolved, bindings)

  if (type.indexOnly && resolved.length === 0) {
    const route = terminalRoute(type, clauses, orderBy, input, admissible, request.limit ?? DEFAULT_QUERY_LIMIT)
    if (route) return route
  }

  // `select_best_index` (query.rs:3375-3515).
  const matched = indexForTypesMatching(type, input, admissible)
  if (!matched) refuse('query must be for valid indexes: no admissible index covers its fields contiguously')
  if (matched.difference > MAX_INDEX_DIFFERENCE) {
    refuse(`query must better match an existing index (closest ${describeIndex(matched.index)} leaves ${matched.difference} properties unused)`)
  }
  // Documents are not synthesized from a bucketed indexOnly index (terminal.rs:920-946, 956).
  if (type.indexOnly && matched.index.bucketing !== null) {
    refuse('IN_TIME_RANGE document queries are not supported on an indexOnly type: use the count surfaces')
  }
  // Every fanning-out level needs an ordering (single_in.rs:397-425, 516-524, 830-836).
  for (const clause of [clauses.inClauses[0], clauses.range]) {
    if (clause && !orderBy.some((order) => order.field === clause.field)) {
      refuse(`query must have an orderBy field for each range element ("${clause.field}")`)
    }
  }
  return served('index', matched.index)
}

/** `find_best_index_for_multiple_in_clauses` (multi_in.rs:267-395) and its orderBy rule (multi_in.rs:145-155). */
function multipleInQuery(
  type: ModelDocumentType,
  clauses: InternalClauses,
  orderBy: OrderClause[],
  resolved: ResolvedRange[],
  bindings: SkipBinding[],
): Verdict {
  const rangeField = clauses.range?.field ?? null
  const fields: string[] = [...clauses.equal.keys(), ...(rangeField ? [rangeField] : []), ...clauses.inClauses.map((clause) => clause.field)]
  const orderKeys = orderBy.map((clause) => clause.field)
  for (const key of orderKeys) if (!fields.includes(key)) fields.push(key)
  const equalityLength = clauses.equal.size
  let best: { index: ModelIndex; difference: number } | null = null
  for (const index of type.indexes) {
    if (!documentAdmissibleForQuery(index, resolved, bindings)) continue
    const positions = clauses.inClauses.map((clause) => index.properties.findIndex((property) => property.name === clause.field))
    if (positions.some((position) => position < 0)) continue
    const sorted = clauses.inClauses
      .map((clause, position) => ({ clause, position: positions[position] }))
      .sort((a, b) => a.position - b.position)
    if (index.properties.length < equalityLength ||
      !index.properties.slice(0, equalityLength).every((property) => clauses.equal.has(property.name))) continue
    if (!sorted.every((entry, offset) => entry.position === equalityLength + offset)) continue
    if (rangeField !== null && index.properties[equalityLength + sorted.length]?.name !== rangeField) continue
    const deepestIn = sorted[sorted.length - 1].clause.field
    const difference = matchesOverComponents(index.properties, fields, deepestIn, orderKeys)
    if (difference === null) continue
    if (difference === 0) {
      best = { index, difference }
      break
    }
    if (!best || difference < best.difference) best = { index, difference }
  }
  if (!best) refuse('query with multiple in clauses must have them on consecutive index properties after the equality clauses')
  if (best.difference > MAX_INDEX_DIFFERENCE) refuse('query must better match an existing index')
  for (const clause of [...clauses.inClauses, ...(clauses.range ? [clauses.range] : [])]) {
    if (!orderBy.some((order) => order.field === clause.field)) {
      refuse(`query must have an orderBy field for each range element ("${clause.field}")`)
    }
  }
  return served('index (multiple in)', best.index)
}

/**
 * The indexOnly terminal route, `index_only_terminal_clause_selection`
 * (terminal.rs:123-470) with `refuse_incomplete_pivot_pages`
 * (terminal.rs:482-545) and `index_only_pivot_pages_are_complete`
 * (terminal.rs:551-575). Returns null when the generic route owns the query.
 */
function terminalRoute(
  type: ModelDocumentType,
  clauses: InternalClauses,
  orderBy: OrderClause[],
  input: MatchInput,
  admissible: (index: ModelIndex) => boolean,
  limit: number,
): Verdict | null {
  const namesTerminal = (field: string) => type.indexes.some((index) => index.terminal?.includes(field))
  const named = [...input.equalityFields, ...(input.rangeField ? [input.rangeField] : []), ...(input.inField ? [input.inField] : []), ...input.orderBy]
  if (!named.some(namesTerminal)) return null

  const pivotProblem = (index: ModelIndex, position: number, clause: WhereClause): string | null => {
    // Only an `In` pivots: grouping keeps `ContainsAny` its own operator (grouping.rs:79).
    if (clause.operator !== 'in') {
      return `a range clause on "${clause.field}", a prefix property of indexOnly index "${index.name}", is not supported in a query that also names its terminal`
    }
    if (position + 1 !== index.properties.length) {
      return `an in clause on "${clause.field}" of indexOnly index "${index.name}" must sit on its last prefix property`
    }
    const values = Array.isArray(clause.value) ? clause.value.length : 0
    return limit < values ? `an in pivot on "${clause.field}" needs a limit of at least its ${values} values, got ${limit}` : null
  }
  const nonTerminalFanOut = (index: ModelIndex) =>
    [...(clauses.range ? [clauses.range] : []), ...clauses.inClauses].filter((clause) => !index.terminal?.includes(clause.field))
  const pagesComplete = (index: ModelIndex) => {
    if (!index.terminal?.some((component) => named.includes(component))) return true
    return nonTerminalFanOut(index).every((clause) => {
      const position = index.properties.findIndex((property) => property.name === clause.field)
      return position < 0 || pivotProblem(index, position, clause) === null
    })
  }
  const matched = indexForTypesMatchingIncludingTerminal(type, input, (index) => admissible(index) && pagesComplete(index)) ??
    indexForTypesMatchingIncludingTerminal(type, input, admissible)
  if (!matched || !matched.terminalUsed) return null

  const index = matched.index
  const components = index.terminal ?? []
  if (components.length !== 1) refuse(`composite indexOnly terminals are not modeled (index "${index.name}")`)
  const terminal = components[0]
  const terminalClause = clauses.equal.get(terminal) ??
    (clauses.range?.field === terminal ? clauses.range : undefined) ??
    clauses.inClauses.find((clause) => clause.field === terminal)

  const pivots = nonTerminalFanOut(index)
  if (pivots.length > 1) refuse('an indexOnly terminal query supports at most one range or in clause on a prefix property')
  if (pivots.length === 0) {
    if (!index.properties.every((property) => clauses.equal.has(property.name))) {
      refuse(`a clause on indexOnly terminal "${terminal}" requires equality clauses on ALL of index "${index.name}"'s properties`)
    }
    if (terminalClause && fansOut(terminalClause.operator) && !orderBy.some((order) => order.field === terminal)) {
      refuse(`a range or in clause on indexOnly terminal "${terminal}" requires an orderBy on it`)
    }
    return served('indexOnly terminal', index)
  }
  const pivot = pivots[0]
  const position = index.properties.findIndex((property) => property.name === pivot.field)
  const problem = pivotProblem(index, position, pivot)
  if (problem) refuse(problem)
  if (!clauses.equal.has(terminal)) refuse('an in clause on an indexOnly prefix property requires an EQUALITY clause on the terminal')
  if (index.properties.slice(0, position).some((property) => !clauses.equal.has(property.name))) {
    refuse('every prefix property ABOVE a pivot in clause must carry an equality clause')
  }
  if (!orderBy.some((order) => order.field === pivot.field)) {
    refuse(`an in clause on indexOnly prefix property "${pivot.field}" requires an orderBy on it`)
  }
  return served('indexOnly terminal (in pivot)', index)
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

type CountMode = 'aggregate' | 'groupByIn' | 'groupByRange' | 'groupByCompound'

/**
 * `key_array_element_clauses` (canon.rs:39-70): judge typed-array clauses,
 * then key `contains` as an equality and `containsAny` as an `in`, the latter
 * only when the request answers per element.
 */
function keyArrayElementClauses(type: ModelDocumentType, clauses: WhereClause[], groupedByIn: boolean): WhereClause[] {
  const severalAllowed = groupedByIn && !clauses.some((clause) => isRangeOperator(clause.operator))
  return clauses.map((clause) => {
    validateArrayElementClause(type, clause)
    if (clause.operator === 'containsAny' && !severalAllowed) {
      refuse(`containsAny on "${clause.field}" is only answered grouped by "${clause.field}" alone, without a range clause`)
    }
    if (clause.operator === 'contains') return { ...clause, operator: 'equal' }
    if (clause.operator === 'containsAny') return { ...clause, operator: 'in' }
    return clause
  })
}

/**
 * `validate_and_canonicalize_where_clauses` (canon.rs:140-200): the shared
 * grouping rules, minus the ban on ranges over distinct fields (the carrier
 * shape), with same-field bound pairs merged into `between*`.
 */
function canonicalizeAggregateClauses(clauses: WhereClause[]): WhereClause[] {
  const nonRange = clauses.filter((clause) => !isRangeOperator(clause.operator))
  const seen = new Set<string>()
  for (const clause of nonRange) {
    if (seen.has(clause.field)) refuse(`duplicate clauses on "${clause.field}"`)
    seen.add(clause.field)
  }
  if (nonRange.filter((clause) => clause.operator === 'in').length > 1) refuse('aggregate queries take at most one in clause')
  const rangesByField = new Map<string, WhereClause[]>()
  for (const clause of clauses.filter((candidate) => isRangeOperator(candidate.operator))) {
    if (seen.has(clause.field)) refuse(`a range clause has same field as an equality or in clause ("${clause.field}")`)
    rangesByField.set(clause.field, [...(rangesByField.get(clause.field) ?? []), clause])
  }
  const ranges = [...rangesByField.values()].map((group) => (group.length === 1 ? group[0] : mergeBounds(group)))
  return [...nonRange, ...ranges]
}

/** `compute_aggregate_mode_and_check_limit_v0/v2` (agg_mode.rs): groupBy → mode, limit rule. */
function countModeFor(groupBy: readonly string[], clauses: WhereClause[], limit: number | undefined): CountMode {
  const isIn = (field: string) => clauses.some((clause) => (clause.operator === 'in' || clause.operator === 'containsAny') && clause.field === field)
  const isRange = (field: string) => clauses.some((clause) => isRangeOperator(clause.operator) && clause.field === field)
  let mode: CountMode
  if (groupBy.length === 0) mode = 'aggregate'
  else if (groupBy.length === 1 && isIn(groupBy[0])) mode = 'groupByIn'
  else if (groupBy.length === 1 && isRange(groupBy[0])) mode = 'groupByRange'
  else if (groupBy.length === 2 && isIn(groupBy[0]) && isRange(groupBy[1])) mode = 'groupByCompound'
  else refuse(`GROUP BY ${JSON.stringify(groupBy)} is not constrained by an in or range where clause`)
  if (limit !== undefined && (mode === 'aggregate' || mode === 'groupByIn')) {
    refuse(`limit is not valid for a count with ${mode === 'aggregate' ? 'empty GROUP BY' : 'GROUP BY on an in field'}`)
  }
  return mode
}

type CountExecutor = 'pointLookup' | 'range' | 'rangeDistinct' | 'carrier'

/** `detect_mode` with `prove = true` (count_mode.rs:85-280), the SDK's proved count. */
function detectCountExecutor(clauses: WhereClause[], mode: CountMode): CountExecutor {
  const rangeCount = clauses.filter((clause) => isRangeOperator(clause.operator)).length
  const inCount = clauses.filter((clause) => clause.operator === 'in').length
  const distinct = mode === 'groupByRange' || mode === 'groupByCompound'
  if (rangeCount > 1) {
    if (!(mode === 'groupByRange' && rangeCount === 2 && inCount === 0)) {
      refuse('count query supports at most one range where-clause outside the carrier shape')
    }
    return 'carrier'
  }
  if (inCount > 1) refuse('count query supports at most one in where-clause')
  const hasRange = rangeCount === 1
  const hasIn = inCount === 1
  if (hasRange && hasIn && !distinct && mode !== 'groupByIn') {
    refuse('range count queries with an in clause are not supported on the aggregate prove path')
  }
  if (distinct && !hasRange) refuse('GROUP BY on a range field requires a range where-clause')
  if (hasRange && distinct) return 'rangeDistinct'
  if (hasRange && hasIn) return 'carrier'
  if (hasRange) return 'range'
  return 'pointLookup'
}

/** `Index::shallowest_count_chain_position` (index.rs:1571-1580). */
function shallowestCountChainPosition(index: ModelIndex): number | null {
  return minPosition(index, [...index.rankedCountableAt, ...index.rankedAverageableAt])
}

/** `Index::shallowest_sum_chain_position` (index.rs:1584-1592). */
function shallowestSumChainPosition(index: ModelIndex): number | null {
  return minPosition(index, [...index.rankedSummableAt, ...index.rankedAverageableAt])
}

function minPosition(index: ModelIndex, levels: string[]): number | null {
  const positions = levels
    .map((level) => index.properties.findIndex((property) => property.name === level))
    .filter((position) => position >= 0)
  return positions.length === 0 ? null : Math.min(...positions)
}

/** `document_count_chain_position` (count.rs:326-332). */
function documentCountChainPosition(index: ModelIndex): number | null {
  return index.summableOffCountIndex !== null ? shallowestSumChainPosition(index) : shallowestCountChainPosition(index)
}

/** `pins_reach_chain` (query.rs:1457-1461). */
function pinsReachChain(index: ModelIndex, pinDepth: number, chainPosition: number | null): boolean {
  return pinDepth >= 1 && pinDepth < index.properties.length && chainPosition !== null && chainPosition < pinDepth
}

function ranksItsLastProperty(index: ModelIndex): boolean {
  return index.rankedCountable || index.rankedSummable || index.rankedAverageable
}

/** `point_count_reads_documents` (count.rs:343-345). */
function pointCountReadsDocuments(index: ModelIndex): boolean {
  return index.countable || index.summableOffCountIndex !== null
}

/** `terminal_reads_documents` (count.rs:373-375). */
function terminalReadsDocuments(index: ModelIndex): boolean {
  return (index.rangeCountable && index.countable) || index.summableOffCountIndex !== null
}

/** `prefix_to_last_count_reads_documents` (count.rs:358-360). */
function prefixToLastCountReadsDocuments(index: ModelIndex): boolean {
  return terminalReadsDocuments(index) && !ranksItsLastProperty(index)
}

/** `find_countable_index_for_where_clauses` (count_pick.rs:65-200). */
function findCountableIndex(type: ModelDocumentType, clauses: WhereClause[], resolved: ResolvedRange[]): ModelIndex | null {
  const bindings = clauses.map(bindingFor)
  if (clauses.some((clause) => clause.operator !== 'equal' && clause.operator !== 'in')) return null
  const fields = new Set(clauses.map((clause) => clause.field))
  if (fields.size === 0) return null
  const leadingCovered = (index: ModelIndex, depth: number) =>
    index.properties.slice(0, depth).every((property) => fields.has(property.name))
  for (const index of type.indexes) {
    if (!admissibleForQuery(index, resolved, bindings) || !pointCountReadsDocuments(index)) continue
    if (index.properties.length === fields.size && leadingCovered(index, fields.size)) return index
  }
  for (const index of type.indexes) {
    if (!admissibleForQuery(index, resolved, bindings) || !prefixToLastCountReadsDocuments(index)) continue
    const leading = index.properties.length - 1
    if (leading === fields.size && leading > 0 && leadingCovered(index, leading)) return index
  }
  for (const index of type.indexes) {
    if (!admissibleForQuery(index, resolved, bindings) || !pointCountReadsDocuments(index)) continue
    if (pinsReachChain(index, fields.size, documentCountChainPosition(index)) && leadingCovered(index, fields.size)) return index
  }
  return null
}

/** `find_range_countable_index_for_where_clauses` (count_pick.rs:215-357). */
function findRangeCountableIndex(type: ModelDocumentType, clauses: WhereClause[], resolved: ResolvedRange[]): ModelIndex | null {
  const bindings = clauses.map(bindingFor)
  const ranges = clauses.filter((clause) => isRangeOperator(clause.operator))
  if (ranges.length < 1 || ranges.length > 2) return null
  if (ranges.length === 2 && ranges[0].field === ranges[1].field) return null
  if (clauses.some((clause) => clause.operator !== 'equal' && clause.operator !== 'in' && !isRangeOperator(clause.operator))) return null
  const prefixFields = new Set(clauses.filter((clause) => clause.operator === 'equal' || clause.operator === 'in').map((clause) => clause.field))
  for (const index of type.indexes) {
    if (!admissibleForQuery(index, resolved, bindings) || !terminalReadsDocuments(index)) continue
    const properties = index.properties
    if (ranges.length === 2) {
      const terminator = properties[properties.length - 1].name
      const outer = terminator === ranges[0].field ? ranges[1].field : terminator === ranges[1].field ? ranges[0].field : null
      if (outer === null || properties[0].name !== outer) continue
      const middle = properties.slice(1, -1)
      if (middle.every((property) => prefixFields.has(property.name)) && middle.length === prefixFields.size) return index
      continue
    }
    let prefixLength = 0
    for (const property of properties) {
      if (!prefixFields.has(property.name)) break
      prefixLength += 1
    }
    if (prefixLength < prefixFields.size || prefixLength + 1 !== properties.length) continue
    if (properties[prefixLength].name === ranges[0].field) return index
  }
  return null
}

/** Whether a proved `documents.count` on `type` is served, and by which index. */
export function checkCountQuery(type: ModelDocumentType, request: CountRequest): Verdict {
  return evaluate(type, [...requestFields(request.where, request.orderBy), ...(request.groupBy ?? [])], Boolean(request.timeRange?.length), () => {
    const { clauses: resolvedClauses, resolved } = resolveTimeRanges(type, request.timeRange)
    const raw = [...parseWhere(request.where), ...resolvedClauses]
    const mode = countModeFor(request.groupBy ?? [], raw, request.limit)
    const clauses = canonicalizeAggregateClauses(keyArrayElementClauses(type, raw, mode === 'groupByIn'))
    const executor = detectCountExecutor(clauses, mode)
    if (executor === 'pointLookup') {
      // Empty where reads the primary-key count tree (count_lookup.rs:27-44).
      if (clauses.length === 0) {
        if (type.documentsCountable) return served('documentsCountable', null)
        refuse(`a whole-type count needs documentsCountable on "${type.name}"`)
      }
      const index = findCountableIndex(type, clauses, resolved)
      if (!index) refuse('no countable index covers the where fields exactly, as all-but-the-last of a rangeCountable index, or down a rankedCountable at-chain')
      return served(`count ${executor}`, index)
    }
    const index = findRangeCountableIndex(type, clauses, resolved)
    if (!index) refuse('no rangeCountable index has the equality/in fields as its prefix and the range field as its last property')
    return served(`count ${executor}`, index)
  })
}

// ---------------------------------------------------------------------------
// Ranked
// ---------------------------------------------------------------------------

/** Whether a `documents.ranked` read on `type` is served (ranked_mode.rs:15-97, ranked_pick.rs:85-195). */
export function checkRankedQuery(type: ModelDocumentType, request: RankedRequest): Verdict {
  return evaluate(type, [...requestFields(request.where, undefined), request.groupBy], Boolean(request.timeRange?.length), () => {
    const { clauses: resolvedClauses, resolved } = resolveTimeRanges(type, request.timeRange)
    // An explicit limit of 1..MAX_RANKED_LIMIT (ranked_mode.rs:200-245).
    if (request.limit === undefined || request.limit < 1 || request.limit > MAX_RANKED_LIMIT) {
      refuse(`a ranked read needs a limit of 1..${MAX_RANKED_LIMIT}, got ${request.limit ?? 'none'}`)
    }
    // Ranked reads read one element at most (canon.rs:39-70 with `grouped_by_in = false`).
    const clauses = keyArrayElementClauses(type, [...parseWhere(request.where), ...resolvedClauses], false)
    const pins: string[] = []
    let branching: string | null = null
    for (const clause of clauses) {
      if (pins.includes(clause.field)) refuse(`a ranked query pins "${clause.field}" twice`)
      if (clause.operator === 'in') {
        const values = Array.isArray(clause.value) ? clause.value.length : 0
        if (values === 0) refuse('an in pin\'s element list is empty')
        if (values > MAX_PREFIX_IN_BRANCHES) refuse(`an in pin fans out to ${values} branches, above ${MAX_PREFIX_IN_BRANCHES}`)
        if (values > 1) {
          if (branching !== null) refuse(`a ranked query takes at most one branching in ("${branching}" already carries it)`)
          branching = clause.field
        }
      } else if (clause.operator !== 'equal') {
        refuse(`a ranked query's where clauses pin leading properties with == or one in; "${clause.field}" uses a range`)
      }
      pins.push(clause.field)
    }
    const axis = request.aggregate.type
    const field = request.aggregate.type === 'count' ? '' : request.aggregate.property
    const bindings = [...pins, request.groupBy].map((name) => ({ field: name, excludesMissing: true, constrains: true }))
    const index = type.indexes.find((candidate) => {
      if (!admissibleForQuery(candidate, resolved, bindings)) return false
      const summedName = candidate.summable ?? candidate.summableOffCountIndex
      const positions = (at: string[], terminal: boolean) => [
        ...at.map((level) => candidate.properties.findIndex((property) => property.name === level)).filter((position) => position >= 0),
        ...(terminal ? [candidate.properties.length - 1] : []),
      ]
      // `read_axis_for`: a count over a summableOffCountIndex index reads its sums.
      const levels = axis === 'count'
        ? candidate.summableOffCountIndex !== null
          ? positions(candidate.rankedSummableAt, candidate.rankedSummable)
          : positions(candidate.rankedCountableAt, candidate.rankedCountable)
        : summedName !== field
          ? []
          : axis === 'sum'
            ? positions(candidate.rankedSummableAt, candidate.rankedSummable)
            : positions(candidate.rankedAverageableAt, candidate.rankedAverageable)
      return levels.some((position) => {
        const leading = candidate.properties.slice(0, position)
        return candidate.properties[position]?.name === request.groupBy &&
          leading.length === pins.length && leading.every((property) => pins.includes(property.name))
      })
    })
    if (!index) refuse(`no ranked index ranks "${request.groupBy}" on the ${axis} axis with exactly [${pins.join(', ')}] pinned before it`)
    return served(`ranked ${axis}`, index)
  })
}

// ---------------------------------------------------------------------------
// Average (point lookups)
// ---------------------------------------------------------------------------

/** `summable_point_lookup_carries_counts` (sum_pick.rs:222-236). */
function summablePointLookupCarriesCounts(index: ModelIndex, clauses: WhereClause[]): boolean {
  if (!index.countable) return false
  let pinDepth = 0
  for (const property of index.properties) {
    if (!clauses.some((clause) => clause.field === property.name)) break
    pinDepth += 1
  }
  return pinDepth === index.properties.length ||
    pinsReachChain(index, pinDepth, shallowestCountChainPosition(index)) ||
    (index.rangeCountable && prefixToLastSumReads(index, pinDepth))
}

/** `prefix_to_last_sum_reads` (sum_pick.rs:206-213). */
function prefixToLastSumReads(index: ModelIndex, pinDepth: number): boolean {
  return index.summableOffCountIndex !== null && !ranksItsLastProperty(index) && pinDepth >= 1 &&
    pinDepth + 1 === index.properties.length &&
    (index.rangeCountable || !pinsReachChain(index, pinDepth, shallowestSumChainPosition(index)))
}

/** `find_summable_index_with_counts_for_where_clauses` (sum_pick.rs:66-195). */
function findSummableIndexWithCounts(type: ModelDocumentType, clauses: WhereClause[], sumProperty: string): ModelIndex | null {
  const bindings = clauses.map(bindingFor)
  if (clauses.some((clause) => clause.operator !== 'equal' && clause.operator !== 'in')) return null
  const fields = new Set(clauses.map((clause) => clause.field))
  if (fields.size === 0) return null
  const accepts = (index: ModelIndex) => index.summableOffCountIndex === null || summablePointLookupCarriesCounts(index, clauses)
  const candidate = (index: ModelIndex) =>
    admissibleForQuery(index, [], bindings) && (index.summable ?? index.summableOffCountIndex) === sumProperty
  const leadingCovered = (index: ModelIndex, depth: number) =>
    index.properties.slice(0, depth).every((property) => fields.has(property.name))
  const picked =
    type.indexes.find((index) => candidate(index) && index.properties.length === fields.size && leadingCovered(index, fields.size) && accepts(index)) ??
    type.indexes.find((index) => candidate(index) && prefixToLastSumReads(index, fields.size) && leadingCovered(index, fields.size) && accepts(index)) ??
    type.indexes.find((index) => candidate(index) &&
      pinsReachChain(index, fields.size, shallowestSumChainPosition(index)) && leadingCovered(index, fields.size) && accepts(index))
  if (!picked) return null
  return picked.summableOffCountIndex !== null || summablePointLookupCarriesCounts(picked, clauses) ? picked : null
}

/** Whether a proved `documents.average` on `type` is served (avg.rs:150-395, point lookups only). */
export function checkAverageQuery(type: ModelDocumentType, request: AverageRequest): Verdict {
  return evaluate(type, [...requestFields(request.where, undefined), ...(request.groupBy ?? [])], false, () => {
    const raw = parseWhere(request.where)
    const mode = countModeFor(request.groupBy ?? [], raw, undefined)
    const clauses = canonicalizeAggregateClauses(keyArrayElementClauses(type, raw, mode === 'groupByIn'))
    if (clauses.some((clause) => isRangeOperator(clause.operator))) refuse('range averages are not modeled')
    if (mode !== 'aggregate' && mode !== 'groupByIn') refuse('GROUP BY a range field needs a range clause')
    if (mode === 'aggregate' && clauses.length === 0) {
      if (type.documentsCountable && type.documentsSummable === request.sumProperty) return served('documentsAverageable', null)
      refuse(`a whole-type average needs documentsCountable and documentsSummable "${request.sumProperty}"`)
    }
    const index = findSummableIndexWithCounts(type, clauses, request.sumProperty)
    if (!index) refuse(`no index sums "${request.sumProperty}" with a countable terminator covering the where fields`)
    return served('average point lookup', index)
  })
}

// ---------------------------------------------------------------------------
// Composite sub-queries
// ---------------------------------------------------------------------------

export interface CompositePageShape extends DocumentsRequest {
  subQueryCount: number
}

/**
 * A composite page: `validate_composite` (composite.rs:404-470) and the
 * array-element rule that refuses `containsAny` beside sub-queries
 * (query.rs:2640-2648), then the page as a documents query. Not modeled:
 * the sub-queries' walk direction agreeing with the page's, and the merged
 * components' path checks (composite.rs:943-1080, 1301-1339).
 */
export function checkCompositePage(type: ModelDocumentType, page: CompositePageShape): Verdict {
  return evaluate(type, requestFields(page.where, page.orderBy), false, () => {
    if (page.subQueryCount < 1 || page.subQueryCount > MAX_SUB_QUERIES) {
      refuse(`a composite query carries 1..${MAX_SUB_QUERIES} sub-queries, got ${page.subQueryCount}`)
    }
    if (page.limit === undefined || page.limit < 1 || page.limit > MAX_BOUND_VALUES) {
      refuse(`a composite page needs an explicit limit of 1..${MAX_BOUND_VALUES}, got ${page.limit ?? 'none'}`)
    }
    if (page.startAt !== undefined || page.startAfter !== undefined) refuse('composite queries take no page cursor')
    const where = parseWhere(page.where)
    if (where.some((clause) => clause.operator === 'containsAny')) refuse('containsAny is not supported in a composite page')
    const byIds = where.find((clause) => clause.field === '$id' && clause.operator === 'in')
    if (byIds && Array.isArray(byIds.value) && page.limit < byIds.value.length) {
      refuse(`a by-ids composite page addresses ${byIds.value.length} ids but its limit is ${page.limit}`)
    }
    return documentsQuery(type, page)
  })
}

export interface CompositeSubQueryShape {
  kind?: 'documents' | 'counts'
  where?: readonly WhereTuple[]
  orderBy?: readonly OrderTuple[]
  limit?: number
  bind?: { field: string; source?: unknown; sourceProperty?: string }
}

/**
 * One composite sub-query lowered the way `sub_query_document_query_with_direction`
 * and `sub_query_count_query` lower it (composite.rs:1119-1260, 476-560):
 * a by-id join reads the primary key, a bound lookup adds `field IN values`
 * (ordered by the field in the page's direction unless already ordered), a
 * bound count adds the same `in` and needs a countable index over it.
 */
export function checkCompositeSubQuery(
  type: ModelDocumentType,
  subQuery: CompositeSubQueryShape,
  pageAscending: boolean,
): Verdict {
  const fields = [...requestFields(subQuery.where, subQuery.orderBy), ...(subQuery.bind ? [subQuery.bind.field] : [])]
  return evaluate(type, fields, false, () => {
    const where = parseWhere(subQuery.where)
    if (where.some((clause) => clause.operator === 'containsAny')) refuse('containsAny is not supported in a sub-query')
    const bind = subQuery.bind
    if (subQuery.kind === 'counts') {
      if (!bind) refuse('a count sub-query must be bound')
      const clauses = [...keyArrayElementClauses(type, where, false), { field: bind.field, operator: 'in' as const, value: [bind.field] }]
      const index = findCountableIndex(type, clauses, [])
      if (!index) refuse(`a count sub-query needs a countable index covering its fixed clauses and the bound field "${bind.field}"`)
      return served('composite count', index)
    }
    if (bind?.field === '$id') {
      if (where.length > 0) refuse('a by-id join takes no fixed clauses')
      if (type.indexOnly) refuse('indexOnly documents cannot be fetched by id')
      return served('composite by-id join', null)
    }
    if (!bind) {
      if (!subQuery.limit) refuse('a sibling documents sub-query requires an explicit limit')
      return documentsQuery(type, { where: subQuery.where, orderBy: subQuery.orderBy, limit: subQuery.limit })
    }
    const orderBy: OrderTuple[] = [...(subQuery.orderBy ?? [])]
    if (!orderBy.some(([field]) => field === bind.field)) orderBy.push([bind.field, pageAscending ? 'asc' : 'desc'])
    return documentsQuery(type, {
      where: [...(subQuery.where ?? []), [bind.field, 'in', [bind.field]]],
      orderBy,
      limit: subQuery.limit,
    })
  })
}
