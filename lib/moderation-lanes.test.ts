import { describe, expect, it } from 'vitest'
import {
  documentComparator,
  isLaned,
  laneVariants,
  mergeLanePages,
  sumLaneAverages,
  sumLaneMaps,
  type LaneCursor,
  type LanePage,
  type WhereClause,
} from './moderation-lanes'

describe('laneVariants', () => {
  it('fans a social listing out to six lanes, the request itself first', () => {
    const where: WhereClause[] = [['live', '==', 1], ['mod', '==', null], ['$createdAt', '>', 0]]
    const lanes = laneVariants(where)
    expect(lanes).toHaveLength(6)
    expect(lanes[0]).toEqual(where)
    expect(lanes.map((lane) => [lane[0][2], lane[1][2]])).toEqual([
      [1, null], [1, 1], [1, 2],
      [2, null], [2, 1], [2, 2],
    ])
    // Everything that is not a lane pin rides along unchanged.
    for (const lane of lanes) expect(lane[2]).toEqual(['$createdAt', '>', 0])
  })

  it('finds the lanes wherever the pins sit among other clauses', () => {
    const lanes = laneVariants<WhereClause>([['live', '==', 1], ['mod', '==', null], ['$ownerId', '==', 'A'], ['$createdAt', '>', 0]])
    expect(lanes).toHaveLength(6)
    for (const lane of lanes) expect(lane.slice(2)).toEqual([['$ownerId', '==', 'A'], ['$createdAt', '>', 0]])
  })

  it('fans a mention read out to three lanes (no live beside mod)', () => {
    const lanes = laneVariants<WhereClause>([['mentionedUserIds', 'contains', 'ME'], ['mod', '==', null], ['$createdAt', '>', 0]])
    expect(lanes.map((lane) => lane[1][2])).toEqual([null, 1, 2])
    expect(lanes.every((lane) => lane[0][2] === 'ME')).toBe(true)
  })

  it('leaves v17 `live == true` reads, and `live == 1` without a mod pin, as one lane', () => {
    const v17: WhereClause[] = [['live', '==', true], ['$createdAt', '>', 0]]
    expect(laneVariants(v17)).toEqual([v17])
    const noMod: WhereClause[] = [['live', '==', 1], ['$createdAt', '>', 0]]
    expect(laneVariants(noMod)).toEqual([noMod])
    expect(isLaned(v17)).toBe(false)
  })

  it('leaves a moderation log read (`mod == 1`) and a read without a where as one lane', () => {
    const log: WhereClause[] = [['mod', '==', 1], ['$moderatedAt', '>', 0]]
    expect(laneVariants(log)).toEqual([log])
    expect(laneVariants(undefined)).toEqual([[]])
    expect(isLaned(log)).toBe(false)
    expect(isLaned([['mod', '==', null]])).toBe(true)
  })

  it('returns copies, never the caller\'s clauses', () => {
    const where: WhereClause[] = [['mod', '==', null]]
    const lanes = laneVariants(where)
    lanes[0][0][2] = 'changed'
    expect(where[0][2]).toBeNull()
  })
})

interface Doc { id: string; at: number }
const byAtDesc = documentComparator<Doc>([['$createdAt', 'desc']], (doc, field) => (field === '$createdAt' ? doc.at : doc.id))
const byAtAsc = documentComparator<Doc>([['$createdAt', 'asc']], (doc, field) => (field === '$createdAt' ? doc.at : doc.id))
const idOf = <T extends { id: string }>(item: T) => item.id
const doc = (id: string, at: number): Doc => ({ id, at })
const page = (docs: Doc[], full = false): LanePage<Doc> => ({ docs, full })

describe('documentComparator', () => {
  it('orders by the ordered property in its direction', () => {
    const docs = [doc('a', 1), doc('b', 3), doc('c', 2)]
    expect([...docs].sort(byAtDesc).map(idOf)).toEqual(['b', 'c', 'a'])
    expect([...docs].sort(byAtAsc).map(idOf)).toEqual(['a', 'c', 'b'])
  })

  it('breaks ties by $id in the direction of the last ordered property', () => {
    const docs = [doc('a', 5), doc('c', 5), doc('b', 5)]
    expect([...docs].sort(byAtDesc).map(idOf)).toEqual(['c', 'b', 'a'])
    expect([...docs].sort(byAtAsc).map(idOf)).toEqual(['a', 'b', 'c'])
  })

  it('ignores the lane properties in the order', () => {
    const compare = documentComparator<Doc>([['live', 'asc'], ['mod', 'asc'], ['$createdAt', 'desc']], (d, field) => (field === '$createdAt' ? d.at : d.id))
    expect(compare(doc('a', 1), doc('b', 2))).toBeGreaterThan(0)
  })

  it('sorts nulls first ascending and last descending', () => {
    type Row = { id: string; value: number | null }
    const read = (row: Row, field: string) => (field === 'value' ? row.value : row.id)
    const asc = documentComparator<Row>([['value', 'asc']], read)
    const desc = documentComparator<Row>([['value', 'desc']], read)
    const rows: Row[] = [{ id: 'a', value: 2 }, { id: 'b', value: null }, { id: 'c', value: 1 }]
    expect([...rows].sort(asc).map(idOf)).toEqual(['b', 'c', 'a'])
    expect([...rows].sort(desc).map(idOf)).toEqual(['a', 'c', 'b'])
  })

  it('compares bigints with numbers', () => {
    const compare = documentComparator<{ id: string; n: bigint | number }>([['n', 'asc']], (row, field) => (field === 'n' ? row.n : row.id))
    expect(compare({ id: 'a', n: 5n }, { id: 'b', n: 7 })).toBeLessThan(0)
  })

  it('compares identifiers as their 32 bytes, not as text', () => {
    // 43 and 44 character base58 strings: the smaller value has the shorter text, which sorts after "2…" as text.
    const small = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
    const big = '21111111111111111111111111111111111111111112'
    expect(small < big).toBe(false)
    const compare = documentComparator<{ id: string; owner: string }>([['$ownerId', 'asc']], (row, field) => (field === '$ownerId' ? row.owner : row.id))
    expect(compare({ id: 'a', owner: small }, { id: 'b', owner: big })).toBeLessThan(0)
    expect(compare({ id: 'a', owner: big }, { id: 'b', owner: small })).toBeGreaterThan(0)
  })

  it('falls back to $id ascending when nothing is ordered', () => {
    const compare = documentComparator<Doc>(undefined, (d, field) => (field === '$createdAt' ? d.at : d.id))
    expect([doc('b', 1), doc('a', 9)].sort(compare).map(idOf)).toEqual(['a', 'b'])
  })
})

describe('mergeLanePages', () => {
  it('takes the first documents of the union in order and reports each lane\'s cursor', () => {
    const a = page([doc('a1', 100), doc('a2', 90)])
    const b = page([doc('b1', 95), doc('b2', 85)], true)
    const merged = mergeLanePages([a, b], [null, null], 3, byAtDesc, idOf)
    expect(merged.docs.map(idOf)).toEqual(['a1', 'b1', 'a2'])
    // Lane a gave all it had and was short of a full page: exhausted. Lane b gave one and has more.
    expect(merged.cursors).toEqual(['done', 'b1'])
    expect(merged.more).toBe(true)
  })

  it('merges ascending lanes in ascending order', () => {
    const a = page([doc('a1', 10), doc('a2', 30)])
    const b = page([doc('b1', 20), doc('b2', 40)])
    const merged = mergeLanePages([a, b], [null, null], 10, byAtAsc, idOf)
    expect(merged.docs.map(idOf)).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(merged.cursors).toEqual(['done', 'done'])
    expect(merged.more).toBe(false)
  })

  it('keeps a full lane open at its last document even when every document was taken', () => {
    const a = page([doc('a1', 100), doc('a2', 90)], true)
    const merged = mergeLanePages([a], [null], 5, byAtDesc, idOf)
    expect(merged.cursors).toEqual(['a2'])
    expect(merged.more).toBe(true)
  })

  it('leaves a lane that gave nothing at its previous cursor, and an exhausted lane done', () => {
    const a = page([doc('a1', 100), doc('a2', 99)], true)
    const b = page([doc('b1', 10)], true)
    const previous: LaneCursor[] = ['A0', 'B0', 'done']
    const merged = mergeLanePages([a, b, page([])], previous, 2, byAtDesc, idOf)
    expect(merged.docs.map(idOf)).toEqual(['a1', 'a2'])
    expect(merged.cursors).toEqual(['a2', 'B0', 'done'])
    expect(merged.more).toBe(true)
  })

  it('keeps a null previous cursor for a lane it has not read from yet', () => {
    const a = page([doc('a1', 100)], true)
    const b = page([doc('b1', 10)], true)
    expect(mergeLanePages([a, b], [null, null], 1, byAtDesc, idOf).cursors).toEqual(['a1', null])
  })

  it('shows a document that two lanes both return once, and moves both lanes past it', () => {
    const a = page([doc('x', 100), doc('a2', 50)])
    const b = page([doc('x', 100), doc('b2', 60)])
    const merged = mergeLanePages([a, b], [null, null], 10, byAtDesc, idOf)
    expect(merged.docs.map(idOf)).toEqual(['x', 'b2', 'a2'])
    expect(merged.cursors).toEqual(['done', 'done'])
  })

  it('has no more when every lane is done', () => {
    const merged = mergeLanePages([page([]), page([])], ['done', null], 5, byAtDesc, idOf)
    expect(merged.docs).toEqual([])
    expect(merged.cursors).toEqual(['done', 'done'])
    expect(merged.more).toBe(false)
  })

  it('reports more when a lane still holds documents it was not asked for', () => {
    const a = page([doc('a1', 100), doc('a2', 99), doc('a3', 98)])
    const merged = mergeLanePages([a], [null], 2, byAtDesc, idOf)
    expect(merged.docs.map(idOf)).toEqual(['a1', 'a2'])
    expect(merged.cursors).toEqual(['a2'])
    expect(merged.more).toBe(true)
  })
})

describe('sumLaneMaps and sumLaneAverages', () => {
  it('adds the per-key counts of the lanes', () => {
    const total = sumLaneMaps([
      new Map([['x', 2n], ['y', 1n]]),
      new Map([['y', 4n]]),
      new Map<string, bigint>(),
      new Map([['z', 7n]]),
    ])
    expect(Array.from(total.entries()).sort()).toEqual([['x', 2n], ['y', 5n], ['z', 7n]])
  })

  it('adds the per-key counts and sums of the lanes\' averages', () => {
    const total = sumLaneAverages([
      new Map([['s1', { count: 2n, sum: 10n }]]),
      new Map([['s1', { count: 1n, sum: 5n }], ['s2', { count: 3n, sum: 9n }]]),
    ])
    expect(total.get('s1')).toEqual({ count: 3n, sum: 15n })
    expect(total.get('s2')).toEqual({ count: 3n, sum: 9n })
  })
})
