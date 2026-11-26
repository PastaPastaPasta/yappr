import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const page = (name) => readFileSync(new URL(`../site-archive/devnet/${name}/index.html`, import.meta.url), 'utf8')

describe('archived Yappr Dev policy pages', () => {
  it.each([
    ['terms', 'Terms of Use'],
    ['privacy', 'Privacy Policy'],
    ['cookies', 'Cookies &amp; Storage'],
  ])('%s is a standalone page with the devnet text and the retirement banner', (name, title) => {
    const html = page(name)
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain(`<h1>${title}</h1>`)
    expect(html).toContain('Yappr Dev has been retired')
    expect(html).toContain('Last updated: October 22, 2026')
    expect(html).not.toMatch(/<script|<link|src=|_next|Testnet/i)
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
      expect(['/', '#community-rules', '/devnet/privacy/', '/devnet/cookies/', 'mailto:support@dash.org']).toContain(href)
    }
  })
  it('keeps the devnet notice', () => {
    expect(page('terms')).toContain('This release of Yappr runs on a Dash Platform devnet.')
    expect(page('privacy')).toContain('This release of Yappr runs on a Dash Platform devnet.')
  })
})
