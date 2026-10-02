import * as collection from '@dicebear/collection'
import { createAvatar } from '@dicebear/core'
import { describe, expect, it } from 'vitest'
import * as shim from '../../src/avatars/collection-shim'

describe('the @dicebear/collection stand-in in engine.js', () => {
  it('stands in for every style the collection exports', () => {
    const { installAvatarStyles, ...styles } = shim
    expect(typeof installAvatarStyles).toBe('function')
    expect(Object.keys(styles).sort()).toEqual(Object.keys(collection).sort())
  })

  it('draws nothing before the styles arrive, then exactly what the real style draws', () => {
    expect(() => createAvatar(shim.thumbs, { seed: 'engine' })).toThrow(/not loaded yet \(thumbs\)/)
    shim.installAvatarStyles(collection)
    expect(createAvatar(shim.notionists, { seed: 'engine' }).toString())
      .toBe(createAvatar(collection.notionists, { seed: 'engine' }).toString())
  })
})
