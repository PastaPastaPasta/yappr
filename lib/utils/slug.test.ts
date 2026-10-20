import { describe, expect, it } from 'vitest'
import { generateSlug, isValidSlug, titleSlug } from './slug'

describe('generateSlug', () => {
  it('lowercases, strips accents and punctuation, and hyphenates spaces', () => {
    expect(generateSlug('  Héllo, Wörld!  It’s   Yappr ')).toBe('hello-world-its-yappr')
  })

  it('collapses runs of hyphens and trims them from the ends', () => {
    expect(generateSlug('--a -- b--')).toBe('a-b')
  })

  it('truncates to 63 characters without a trailing hyphen', () => {
    const slug = generateSlug(Array.from({ length: 40 }, () => 'ab').join(' '))
    expect(slug.length).toBeLessThanOrEqual(63)
    expect(slug.endsWith('-')).toBe(false)
    expect(isValidSlug(slug)).toBe(true)
  })

  it('falls back to a timestamp slug when nothing survives', () => {
    expect(generateSlug('日本語')).toMatch(/^post-[0-9a-z]+$/)
    expect(generateSlug('🎉🎉')).toMatch(/^post-[0-9a-z]+$/)
  })
})

describe('titleSlug', () => {
  it('is the title-derived slug, empty when nothing survives', () => {
    expect(titleSlug('Hello, World')).toBe('hello-world')
    expect(titleSlug('日本語')).toBe('')
  })
})

describe('isValidSlug', () => {
  it('accepts lowercase alphanumerics separated by single hyphens', () => {
    expect(isValidSlug('a')).toBe(true)
    expect(isValidSlug('hello-world-2')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isValidSlug('')).toBe(false)
    expect(isValidSlug('Hello')).toBe(false)
    expect(isValidSlug('a--b')).toBe(false)
    expect(isValidSlug('-a')).toBe(false)
    expect(isValidSlug('a'.repeat(64))).toBe(false)
  })
})
