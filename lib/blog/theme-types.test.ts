import { describe, expect, it } from 'vitest'
import { isSafeCssValue, sanitizeCustomCSS } from './theme-types'

describe('isSafeCssValue', () => {
  it('accepts colours and gradients', () => {
    expect(isSafeCssValue('rgba(15, 23, 42, 0.55)')).toBe(true)
    expect(isSafeCssValue('linear-gradient(135deg, #0f172a, #1e293b)')).toBe(true)
  })

  it('refuses a value that loads an image (it would skip the media rules and the takedown denylist) or escapes its declaration', () => {
    for (const value of [
      'url("https://ipfs.io/ipfs/bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va")',
      'linear-gradient(red, blue), URL (https://tracker.example/p.png)',
      'red; background-image: none',
      'image-set("data:image/png;base64,AAAA" 1x)',
      '-webkit-image-set("https://ipfs.io/ipfs/bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va" 1x)',
      'src("https://tracker.example/p.png")',
      'u\\72l("https://ipfs.io/ipfs/bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va")',
      'ur/**/l("https://tracker.example/p.png")',
    ]) {
      expect(isSafeCssValue(value)).toBe(false)
    }
  })
})

describe('sanitizeCustomCSS', () => {
  it('drops a declaration whose value spells url() with a CSS escape, and keeps the rest', () => {
    expect(sanitizeCustomCSS('color: red; background: u\\72l("https://ipfs.io/ipfs/bafybeie5gq4jxvzmsym6hjlwxej4rwdoxt7wadqvmmwbqi7r27fclha2va")'))
      .toBe('color: red')
  })
})
