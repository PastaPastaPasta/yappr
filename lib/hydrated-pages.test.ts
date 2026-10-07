import { describe, expect, it } from 'vitest'
import { appendPage, dropFromPages } from './hydrated-pages'

describe('dropFromPages', () => {
  const pages = { keys: ['a', 'b', 'c', 'd', 'e'], loaded: 3, items: ['A', 'B', 'C'] }

  it('drops a hydrated key and its item, so the next page still starts at the first unloaded key', () => {
    const next = dropFromPages(pages, key => key !== 'b', item => item !== 'B')
    expect(next).toEqual({ keys: ['a', 'c', 'd', 'e'], loaded: 2, items: ['A', 'C'] })
    expect(next.keys.slice(next.loaded)).toEqual(['d', 'e'])
  })

  it('drops a key not hydrated yet without touching loaded', () => {
    expect(dropFromPages(pages, key => key !== 'e', () => true)).toEqual({ keys: ['a', 'b', 'c', 'd'], loaded: 3, items: ['A', 'B', 'C'] })
  })
})

describe('appendPage', () => {
  const pages = { keys: ['a', 'b', 'c', 'd', 'e'], loaded: 3, items: ['A', 'B', 'C'] }

  it('moves loaded past the appended slice', () => {
    expect(appendPage(pages, ['d', 'e'], ['D', 'E'])).toEqual({ keys: pages.keys, loaded: 5, items: ['A', 'B', 'C', 'D', 'E'] })
  })

  it('does not skip a key when an earlier one was dropped while the slice hydrated', () => {
    const dropped = dropFromPages(pages, key => key !== 'b', item => item !== 'B')
    // The slice [d] was taken from the old list; e is still to load.
    const next = appendPage(dropped, ['d'], ['D'])
    expect(next.loaded).toBe(3)
    expect(next.keys.slice(next.loaded)).toEqual(['e'])
  })

  it('does not overrun the list when a key of the slice itself was dropped', () => {
    const dropped = dropFromPages(pages, key => key !== 'e', () => true)
    const next = appendPage(dropped, ['d', 'e'], ['D'])
    expect(next.loaded).toBe(4)
    expect(next.keys.slice(next.loaded)).toEqual([])
  })
})
