import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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


it.each(['', '/yappr'])('replaces legacy master fallbacks during assembly (base %s)', (base) => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
  const step = workflow.split('- name: Install network-free deployment-aware fallback')[1].split('\n      #')[0]
  expect(step).toContain('BASE_PATH: ${{ vars.BASE_PATH }}')
  const command = step.match(/run: \|\n([\s\S]+)/)[1]
  const directory = mkdtempSync(join(tmpdir(), 'yappr-404-'))
  try {
    mkdirSync(join(directory, 'staging/scripts'), { recursive: true })
    copyFileSync(new URL('./write-static-404.mjs', import.meta.url), join(directory, 'staging/scripts/write-static-404.mjs'))
    mkdirSync(join(directory, 'site/testing'), { recursive: true })
    const legacy = '<script src="/testing/_next/legacy-runtime.js"></script>'
    writeFileSync(join(directory, 'site/404.html'), legacy)
    writeFileSync(join(directory, 'site/testing/404.html'), legacy)
    const result = spawnSync(command, { shell: true, cwd: directory, env: { ...process.env, BASE_PATH: base }, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    const html = readFileSync(join(directory, 'site/404.html'), 'utf8')
    expect(html).toContain(`href="${base}/"`)
    expect(html).toContain(`href="${base}/explore/"`)
    expect(html).not.toMatch(/_next|sdk|src=/i)
    const testing = readFileSync(join(directory, 'site/testing/404.html'), 'utf8')
    expect(testing).toBe(staticNotFound('/testing'))
    expect(testing).not.toMatch(/_next|sdk|src=/i)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
