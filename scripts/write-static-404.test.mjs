import { describe, it, expect } from 'vitest'
import { runInNewContext } from 'node:vm'
import { staticNotFound } from './write-static-404.mjs'

function visit(base, pathname) {
  const redirects = []
  const links = { home: {}, explore: {} }
  const html = staticNotFound(base)
  const location = { pathname, replace: (url) => redirects.push(url) }
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    runInNewContext(script, { location, document: { getElementById: (id) => links[id] } })
  }
  return { html, redirects, links }
}

describe('GitHub Pages shared root 404', () => {
  it.each(['devnet', 'testing', 'staging'])('routes /%s failures to that deployment without any runtime', (deployment) => {
    const prefix = '/' + deployment
    const root = visit('', prefix + '/does-not-exist/')
    expect(root.redirects).toEqual([prefix + '/404.html'])
    expect(root.links.home.href).toBe(prefix + '/')
    expect(root.links.explore.href).toBe(prefix + '/explore/')
    expect(root.html).not.toMatch(/_next|sdk|src=/i)
    const missingDeployment = visit('', prefix + '/404.html')
    expect(missingDeployment.redirects).toEqual([])
    expect(missingDeployment.links.home.href).toBe(prefix + '/')
    const destination = visit(prefix, prefix + '/404.html')
    expect(destination.redirects).toEqual([])
    expect(destination.html).toContain(`href="${prefix}/explore/"`)
  })
  it.each(['/other/', '/devnetwork/no/', '/testing-elsewhere/'])('keeps root unknown routes at root: %s', (pathname) => {
    const root = visit('', pathname)
    expect(root.redirects).toEqual([])
    expect(root.html).toContain('href="/"')
  })
  it('refuses unsafe deployment prefixes', () => {
    expect(() => staticNotFound('/"><script>')).toThrow('Invalid deployment prefix')
  })
})
