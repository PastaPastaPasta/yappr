import { describe, expect, it } from 'vitest'
import {
  checkAverageQuery,
  checkCompositePage,
  checkCompositeSubQuery,
  checkCountQuery,
  checkDocumentsQuery,
  checkRankedQuery,
  matchesOverComponents,
  parseContract,
  type ModelDocumentType,
  type Verdict,
} from './query-index-model'

/** A one-doctype contract with the given properties, required list and indices. */
function docType(
  properties: Record<string, unknown>,
  indices: unknown[],
  extra: Record<string, unknown> = {},
): ModelDocumentType {
  const type = parseContract({ documentSchemas: { thing: { type: 'object', properties, indices, ...extra } } }).get('thing')
  if (!type) throw new Error('fixture did not parse')
  return type
}

const int = { type: 'integer' }
const id = { type: 'identifier' }
const asc = (...names: string[]) => names.map((name) => ({ [name]: 'asc' }))

function servedBy(verdict: Verdict): string | null {
  return verdict.servable ? verdict.index : `REFUSED: ${verdict.reason}`
}

describe('the v0 matcher (Index::matches_over_components)', () => {
  const properties = [{ name: 'a', ascending: true }, { name: 'b', ascending: true }, { name: 'c', ascending: true }]

  it('counts unused properties, takes an orderBy run anywhere, and places an in last or before-last', () => {
    expect(matchesOverComponents(properties, ['a', 'b'], null, ['b'])).toBe(1)
    expect(matchesOverComponents(properties, ['a', 'b', 'c'], null, [])).toBe(0)
    expect(matchesOverComponents(properties, ['a'], 'a', [])).toBeNull()
    expect(matchesOverComponents(properties, ['b'], 'b', [])).toBe(2)
    expect(matchesOverComponents(properties, ['a', 'c'], null, ['c', 'b'])).toBeNull()
  })
})

describe('documents queries', () => {
  const abc = docType({ a: int, b: int, c: int, d: int }, [{ name: 'abc', properties: asc('a', 'b', 'c') }], { required: ['a', 'b', 'c'] })

  it('serves a contiguous equality prefix with a range right after it', () => {
    expect(servedBy(checkDocumentsQuery(abc, { where: [['a', '==', 1], ['b', '>', 0]], orderBy: [['b', 'asc']] }))).toBe('abc [a, b, c]')
    expect(servedBy(checkDocumentsQuery(abc, { where: [['a', '==', 1], ['b', '==', 2]], orderBy: [['c', 'desc']] }))).toBe('abc [a, b, c]')
  })

  it('refuses gaps: an unbound leading property, a range past an unbound level, an orderBy skipping one', () => {
    expect(checkDocumentsQuery(abc, { where: [['b', '==', 2]] }).servable).toBe(false)
    expect(checkDocumentsQuery(abc, { where: [['a', '==', 1], ['c', '>', 0]], orderBy: [['c', 'asc']] }).servable).toBe(false)
    expect(checkDocumentsQuery(abc, { where: [['a', '==', 1], ['c', '==', 3], ['b', '>', 0]], orderBy: [['b', 'asc']] }).servable).toBe(false)
    expect(checkDocumentsQuery(abc, { where: [['a', '==', 1]], orderBy: [['c', 'asc']] }).servable).toBe(false)
  })

  it('takes an orderBy run of the index and an in on the last or before-last property', () => {
    expect(checkDocumentsQuery(abc, { where: [['a', '==', 1]], orderBy: [['b', 'asc'], ['c', 'asc']] }).servable).toBe(true)
    expect(checkDocumentsQuery(abc, { where: [['a', '==', 1], ['b', 'in', [1, 2]]], orderBy: [['b', 'asc']] }).servable).toBe(true)
    expect(checkDocumentsQuery(abc, { where: [['a', 'in', [1, 2]]], orderBy: [['a', 'asc']] }).servable).toBe(false)
  })

  it('needs an orderBy on every fanning-out (in or range) field', () => {
    const verdict = checkDocumentsQuery(abc, { where: [['a', '==', 1], ['b', '>', 0]] })
    expect(verdict.servable).toBe(false)
    expect(verdict.servable ? '' : verdict.reason).toMatch(/orderBy field for each range element/)
  })

  it('refuses a limit outside 1..100 and an empty, oversized or repeating in list', () => {
    const where = [['a', '==', 1]] as const
    expect(checkDocumentsQuery(abc, { where, limit: 0 }).servable).toBe(false)
    expect(checkDocumentsQuery(abc, { where, limit: 101 }).servable).toBe(false)
    const inOf = (values: unknown[]) => checkDocumentsQuery(abc, { where: [['a', '==', 1], ['b', 'in', values]], orderBy: [['b', 'asc']] }).servable
    expect(inOf([])).toBe(false)
    expect(inOf(Array.from({ length: 101 }, (_, n) => n))).toBe(false)
    expect(inOf([1, 1])).toBe(false)
  })

  it('refuses a query leaving more than two index properties unused', () => {
    const wide = docType({ a: int, b: int, c: int, d: int }, [{ name: 'abcd', properties: asc('a', 'b', 'c', 'd') }])
    expect(checkDocumentsQuery(wide, { where: [['a', '==', 1], ['b', '==', 1]] }).servable).toBe(true)
    expect(checkDocumentsQuery(wide, { where: [['a', '==', 1]] }).servable).toBe(false)
  })

  it('serves several in clauses on consecutive properties after the equalities, each ordered by', () => {
    const type = docType({ a: int, b: int, c: int }, [{ name: 'abc', properties: asc('a', 'b', 'c') }])
    const where = [['a', '==', 1], ['b', 'in', [1, 2]], ['c', 'in', [3, 4]]] as const
    expect(checkDocumentsQuery(type, { where, orderBy: [['b', 'asc'], ['c', 'asc']] }).servable).toBe(true)
    expect(checkDocumentsQuery(type, { where, orderBy: [['b', 'asc']] }).servable).toBe(false)
  })

  it('reads $id clauses from the primary key, alone, and an empty or $id-ordered query too', () => {
    expect(checkDocumentsQuery(abc, { where: [['$id', 'in', ['x', 'y']]] })).toEqual({ servable: true, route: 'primaryKey', index: null })
    expect(checkDocumentsQuery(abc, {}).servable).toBe(true)
    expect(checkDocumentsQuery(abc, { where: [['$id', '==', 'x'], ['a', '==', 1]] }).servable).toBe(false)
  })
})

describe('the skipIfAbsent gate', () => {
  // `x` is optional, so `skipIfAbsent: true` skips on it.
  const sparse = docType({ x: int, y: int }, [{ name: 'byX', properties: asc('x'), skipIfAbsent: true }])

  it('needs every skip property bound by a constraint no missing value meets', () => {
    expect(checkDocumentsQuery(sparse, { where: [['x', '>', 0]], orderBy: [['x', 'asc']] }).servable).toBe(true)
    expect(checkDocumentsQuery(sparse, { where: [['x', '==', 3]] }).servable).toBe(true)
    expect(checkDocumentsQuery(sparse, { orderBy: [['x', 'asc']] }).servable).toBe(false)
    expect(checkDocumentsQuery(sparse, { where: [['x', '<', 5]], orderBy: [['x', 'asc']] }).servable).toBe(false)
    expect(checkDocumentsQuery(sparse, { where: [['x', '==', null]] }).servable).toBe(false)
  })

  it('does not skip on required or system properties', () => {
    const dense = docType({ x: int }, [{ name: 'byX', properties: asc('x', '$createdAt'), skipIfAbsent: true }], { required: ['x'] })
    expect(checkDocumentsQuery(dense, { where: [['x', '==', 1]], orderBy: [['$createdAt', 'desc']] }).servable).toBe(true)
  })

  it('pins the live marker of a [live, $createdAt] timeline', () => {
    const post = docType({ live: { type: 'boolean', const: true } }, [{ name: 'timeline', properties: asc('live', '$createdAt'), skipIfAbsent: true }])
    expect(checkDocumentsQuery(post, { where: [['live', '==', true], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] }).servable).toBe(true)
    expect(checkDocumentsQuery(post, { where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] }).servable).toBe(false)
  })
})

describe('typed arrays', () => {
  const tags = { type: 'array', items: { type: 'string' }, maxItems: 4 }
  const tagged = docType({ tags, n: int }, [
    { name: 'tagTime', properties: asc('tags', '$createdAt') },
    { name: 'nTags', properties: asc('n', 'tags') },
  ])

  it('reads an array index with contains (an equality on the element) or containsAny (an in)', () => {
    expect(servedBy(checkDocumentsQuery(tagged, { where: [['tags', 'contains', 'dash'], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] })))
      .toBe('tagTime [tags, $createdAt]')
    expect(checkDocumentsQuery(tagged, { where: [['n', '==', 1], ['tags', 'containsAny', ['a', 'b']]], orderBy: [['tags', 'asc']] }).servable).toBe(true)
  })

  it('refuses any other operator on the array, an ordering without containsAny, and an unbound array', () => {
    expect(checkDocumentsQuery(tagged, { where: [['tags', '==', 'dash']] }).servable).toBe(false)
    expect(checkDocumentsQuery(tagged, { where: [['n', 'contains', 1]] }).servable).toBe(false)
    expect(checkDocumentsQuery(tagged, { where: [['tags', 'contains', 'a']], orderBy: [['tags', 'asc']] }).servable).toBe(false)
    expect(checkDocumentsQuery(tagged, { where: [['n', '==', 1]] }).servable).toBe(false)
  })
})

describe('time-range buckets', () => {
  const type = docType({ p: id }, [
    { name: 'recent', properties: asc('$createdAt', 'p'), timeRange: { on: '$createdAt', range: 300, step: 300 } },
  ])

  it('serves a bucketed index only to a resolved selection, never to a raw clause', () => {
    expect(checkDocumentsQuery(type, { where: [['p', '==', 'x']], timeRange: [{ field: '$createdAt', selector: 'newest' }] }).servable).toBe(true)
    expect(checkDocumentsQuery(type, { where: [['$createdAt', '==', 1], ['p', '==', 'x']] }).servable).toBe(false)
  })

  it('refuses an ordering on the bucketed source', () => {
    const request = { where: [['p', '==', 'x']] as const, orderBy: [['$createdAt', 'desc']] as const, timeRange: [{ field: '$createdAt', selector: 'newest' }] }
    expect(checkDocumentsQuery(type, request).servable).toBe(false)
  })
})

describe('indexOnly terminals', () => {
  const like = docType({ postId: id }, [
    { name: 'byPost', properties: asc('postId'), terminal: '$ownerId', countable: 'countable' },
  ], { indexOnly: true, required: ['postId'] })

  it('serves an equality on the terminal under a fully bound prefix', () => {
    expect(checkDocumentsQuery(like, { where: [['postId', '==', 'p'], ['$ownerId', '==', 'me']] }))
      .toEqual({ servable: true, route: 'indexOnly terminal', index: 'byPost [postId] terminal $ownerId' })
  })

  it('serves an in pivot on the last prefix property when ordered by it and the limit covers it', () => {
    const where = [['postId', 'in', ['p', 'q']], ['$ownerId', '==', 'me']] as const
    expect(checkDocumentsQuery(like, { where, orderBy: [['postId', 'asc']] }).servable).toBe(true)
    expect(checkDocumentsQuery(like, { where }).servable).toBe(false)
    expect(checkDocumentsQuery(like, { where, orderBy: [['postId', 'asc']], limit: 1 }).servable).toBe(false)
  })

  it('refuses a terminal clause with an unbound prefix, by-id reads and cursors', () => {
    expect(checkDocumentsQuery(like, { where: [['$ownerId', '==', 'me']] }).servable).toBe(false)
    expect(checkDocumentsQuery(like, { where: [['$id', '==', 'x']] }).servable).toBe(false)
    expect(checkDocumentsQuery(like, { where: [['postId', '==', 'p']], startAfter: 'x' }).servable).toBe(false)
  })

  it('refuses a containsAny pivot and documents read from a bucketed indexOnly index', () => {
    const tagged = docType({ tags: { type: 'array', items: { type: 'string' }, maxItems: 4 }, p: id }, [
      { name: 'byTags', properties: asc('tags'), terminal: '$ownerId', countable: 'countable' },
      { name: 'trend', properties: asc('$createdAt', 'p'), terminal: '$ownerId', timeRange: { on: '$createdAt', range: 300, step: 300 } },
      { name: 'byP', properties: asc('p'), terminal: '$ownerId', countable: 'countable' },
    ], { indexOnly: true, required: ['p'] })
    expect(checkDocumentsQuery(tagged, { where: [['tags', 'containsAny', ['a', 'b']], ['$ownerId', '==', 'me']], orderBy: [['tags', 'asc']] }).servable).toBe(false)
    expect(checkDocumentsQuery(tagged, { where: [['p', '==', 'x']], timeRange: [{ field: '$createdAt', selector: 'newest' }] }).servable).toBe(false)
  })

  it('pages the terminal with a range ordered by it', () => {
    expect(checkDocumentsQuery(like, { where: [['postId', '==', 'p'], ['$ownerId', '>', 'a']], orderBy: [['$ownerId', 'asc']] }).servable).toBe(true)
    expect(checkDocumentsQuery(like, { where: [['postId', '==', 'p'], ['$ownerId', '>', 'a']] }).servable).toBe(false)
  })
})

describe('counts', () => {
  const type = docType({ a: id, b: int, c: int }, [
    { name: 'exact', properties: asc('a'), countable: 'countable' },
    { name: 'byAB', properties: asc('a', 'b'), rangeCountable: true },
    { name: 'plainC', properties: asc('c') },
  ], { documentsCountable: true })

  it('serves exact covers, prefix-to-last on rangeCountable, ranges on the last property, and whole-type totals', () => {
    expect(servedBy(checkCountQuery(type, { where: [['a', '==', 'x']] }))).toBe('exact [a]')
    expect(servedBy(checkCountQuery(type, { where: [['a', '==', 'x'], ['b', '>', 1]] }))).toBe('byAB [a, b]')
    expect(servedBy(checkCountQuery(type, { where: [['a', 'in', ['x', 'y']]], groupBy: ['a'] }))).toBe('exact [a]')
    expect(checkCountQuery(type, {})).toEqual({ servable: true, route: 'documentsCountable', index: null })
  })

  it('refuses a non-countable index, a limit on an aggregate, and a range plus in on the aggregate path', () => {
    expect(checkCountQuery(type, { where: [['c', '==', 1]] }).servable).toBe(false)
    expect(checkCountQuery(type, { where: [['a', '==', 'x']], limit: 5 }).servable).toBe(false)
    expect(checkCountQuery(type, { where: [['a', 'in', ['x', 'y']], ['b', '>', 1]] }).servable).toBe(false)
    expect(checkCountQuery(type, { where: [['a', 'in', ['x', 'y']], ['b', '>', 1]], groupBy: ['a'] }).servable).toBe(true)
  })

  it('needs documentsCountable for a whole-type count', () => {
    const plain = docType({ a: id }, [{ name: 'exact', properties: asc('a'), countable: 'countable' }])
    expect(checkCountQuery(plain, {}).servable).toBe(false)
  })

  it('counts down a rankedCountable at-chain from any contiguous pin depth at or below it', () => {
    const chain = docType({ a: id, b: id }, [
      { name: 'chain', properties: asc('a', 'b', '$createdAt'), rangeCountable: true, rankedCountable: { at: 'a' } },
    ])
    expect(servedBy(checkCountQuery(chain, { where: [['a', '==', 'x']] }))).toBe('chain [a, b, $createdAt]')
  })
})

describe('ranked reads', () => {
  const type = docType({ a: id, b: id }, [
    { name: 'byA', properties: asc('a', 'b'), rangeCountable: true, rankedCountable: { at: 'a' } },
    { name: 'byAB', properties: asc('b', 'a'), rangeCountable: true, rankedCountable: true },
  ])

  it('ranks an at level with nothing pinned and a terminal level under exact pins', () => {
    expect(servedBy(checkRankedQuery(type, { limit: 10, groupBy: 'a', aggregate: { type: 'count' } }))).toBe('byA [a, b]')
    expect(servedBy(checkRankedQuery(type, { limit: 10, groupBy: 'a', aggregate: { type: 'count' }, where: [['b', '==', 'x']] }))).toBe('byAB [b, a]')
  })

  it('needs a limit of 1..100', () => {
    expect(checkRankedQuery(type, { groupBy: 'a', aggregate: { type: 'count' } }).servable).toBe(false)
    expect(checkRankedQuery(type, { limit: 101, groupBy: 'a', aggregate: { type: 'count' } }).servable).toBe(false)
  })

  it('refuses a partial pin, a range pin and an unranked level', () => {
    expect(checkRankedQuery(type, { limit: 10, groupBy: 'b', aggregate: { type: 'count' } }).servable).toBe(false)
    expect(checkRankedQuery(type, { limit: 10, groupBy: 'a', aggregate: { type: 'count' }, where: [['b', '>', 'x']] }).servable).toBe(false)
  })
})

describe('averages', () => {
  const type = docType({ s: id, rating: int }, [
    { name: 'rating', properties: asc('s'), averageable: 'rating', rangeAverageable: true, rankedAverageable: true },
  ], { required: ['s', 'rating'] })

  it('serves a point average over an averageable index covering the pins', () => {
    expect(servedBy(checkAverageQuery(type, { where: [['s', 'in', ['x', 'y']]], groupBy: ['s'], sumProperty: 'rating' }))).toBe('rating [s]')
    expect(checkAverageQuery(type, { where: [['s', '==', 'x']], sumProperty: 'other' }).servable).toBe(false)
  })
})

describe('composite pages', () => {
  const type = docType({ a: id }, [{ name: 'byA', properties: asc('a', '$createdAt') }])
  const page = { where: [['a', '==', 'x']] as const, orderBy: [['$createdAt', 'desc']] as const }

  it('need 1..10 sub-queries, an explicit limit of 1..100, no cursor, and a limit covering a by-ids page', () => {
    expect(checkCompositePage(type, { ...page, limit: 20, subQueryCount: 3 }).servable).toBe(true)
    expect(checkCompositePage(type, { ...page, limit: 20, subQueryCount: 11 }).servable).toBe(false)
    expect(checkCompositePage(type, { ...page, subQueryCount: 1 }).servable).toBe(false)
    expect(checkCompositePage(type, { ...page, limit: 20, subQueryCount: 1, startAfter: 'x' }).servable).toBe(false)
    expect(checkCompositePage(type, { where: [['$id', 'in', ['x', 'y']]], limit: 1, subQueryCount: 1 }).servable).toBe(false)
  })
})

describe('composite sub-queries', () => {
  const type = docType({ a: id, b: int }, [
    { name: 'byA', properties: asc('a', '$createdAt') },
    { name: 'countA', properties: asc('a'), countable: 'countable' },
  ])

  it('reads joins by id, adds the bound in (ordered by it) to lookups, and needs a countable cover for counts', () => {
    expect(checkCompositeSubQuery(type, { bind: { field: '$id' } }, false).servable).toBe(true)
    // The exact cover (difference 0) wins over byA, which leaves $createdAt unused.
    expect(servedBy(checkCompositeSubQuery(type, { bind: { field: 'a' } }, false))).toBe('countA [a]')
    expect(servedBy(checkCompositeSubQuery(type, { bind: { field: 'a' }, where: [['b', '==', 1]] }, false))).toMatch(/^REFUSED/)
    expect(servedBy(checkCompositeSubQuery(type, { kind: 'counts', bind: { field: 'a' } }, false))).toBe('countA [a]')
    expect(checkCompositeSubQuery(type, { kind: 'counts', bind: { field: 'b' } }, false).servable).toBe(false)
  })
})
