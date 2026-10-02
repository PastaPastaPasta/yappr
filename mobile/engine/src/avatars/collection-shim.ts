/**
 * `@dicebear/collection` inside engine.js (aliased in build.mjs only): the
 * 30-odd styles are 2 of the bundle's 3.5 MB, and only avatars need them, so
 * they ship in engine.avatars.js (./entry.ts) and load after the engine has
 * said hello. Each export stands in for one style and reads the real one at
 * call time; `installAvatarStyles` hands them over (../avatar-styles.ts).
 * lib's avatar-generator reads them only when it draws an avatar, which waits
 * for them (`avatarStylesReady`).
 */
import type * as Collection from '@dicebear/collection'
import type { Style } from '@dicebear/core'

type StyleName = keyof typeof Collection

let styles: typeof Collection | null = null

export function installAvatarStyles(collection: typeof Collection): void {
  styles = collection
}

function lazyStyle(name: StyleName): Style<object> {
  const real = (): Style<object> => {
    if (!styles) throw new Error(`Avatar styles are not loaded yet (${name})`)
    return styles[name]
  }
  return {
    get meta() { return real().meta },
    get schema() { return real().schema },
    create: props => real().create(props),
  }
}

export const adventurer = lazyStyle('adventurer')
export const adventurerNeutral = lazyStyle('adventurerNeutral')
export const avataaars = lazyStyle('avataaars')
export const avataaarsNeutral = lazyStyle('avataaarsNeutral')
export const bigEars = lazyStyle('bigEars')
export const bigEarsNeutral = lazyStyle('bigEarsNeutral')
export const bigSmile = lazyStyle('bigSmile')
export const bottts = lazyStyle('bottts')
export const botttsNeutral = lazyStyle('botttsNeutral')
export const croodles = lazyStyle('croodles')
export const croodlesNeutral = lazyStyle('croodlesNeutral')
export const dylan = lazyStyle('dylan')
export const funEmoji = lazyStyle('funEmoji')
export const glass = lazyStyle('glass')
export const icons = lazyStyle('icons')
export const identicon = lazyStyle('identicon')
export const initials = lazyStyle('initials')
export const lorelei = lazyStyle('lorelei')
export const loreleiNeutral = lazyStyle('loreleiNeutral')
export const micah = lazyStyle('micah')
export const miniavs = lazyStyle('miniavs')
export const notionists = lazyStyle('notionists')
export const notionistsNeutral = lazyStyle('notionistsNeutral')
export const openPeeps = lazyStyle('openPeeps')
export const personas = lazyStyle('personas')
export const pixelArt = lazyStyle('pixelArt')
export const pixelArtNeutral = lazyStyle('pixelArtNeutral')
export const rings = lazyStyle('rings')
export const shapes = lazyStyle('shapes')
export const thumbs = lazyStyle('thumbs')
export const toonHead = lazyStyle('toonHead')
