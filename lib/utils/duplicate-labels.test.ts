import { describe, expect, it } from 'vitest'
import { findDuplicateLabels } from './duplicate-labels'

const lower = (label: string) => label.trim().toLowerCase()
// Stand-in for the DPNS homograph-safe conversion (o -> 0, i/l -> 1).
const homographSafe = (label: string) => lower(label).replace(/o/g, '0').replace(/[il]/g, '1')

describe('findDuplicateLabels', () => {
  it('returns nothing for distinct labels', () => {
    expect(findDuplicateLabels(['alice', 'bob'], lower).size).toBe(0)
  })

  it('groups labels by their normalised form', () => {
    expect(findDuplicateLabels(['Alice', ' alice ', 'bob'], lower)).toEqual(new Set(['alice']))
    expect(findDuplicateLabels(['qaname1', 'qanamei', 'qanamel', 'qaname0', 'qanameo'], homographSafe))
      .toEqual(new Set(['qaname1', 'qaname0']))
  })

  it('reports a group once however many labels share it', () => {
    expect(findDuplicateLabels(['a1', 'a1', 'a1'], lower)).toEqual(new Set(['a1']))
  })

  it('ignores labels that normalise to empty', () => {
    expect(findDuplicateLabels(['', '  ', ''], lower).size).toBe(0)
  })
})
