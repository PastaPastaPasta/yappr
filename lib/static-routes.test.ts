import { describe, expect, it } from 'vitest'
import { isStaticRoute } from './static-routes'

describe('routes that do not start Platform or restore auth', () => {
  it.each(['/terms/', '/privacy', '/cookies/', '/about/', '/about/private-feeds/'])('%s stays readable offline', (path) => {
    expect(isStaticRoute(path)).toBe(true)
  })
  it.each(['/feed', '/settings', '/about/something-else', '/contract'])('%s retains its Platform runtime', (path) => {
    expect(isStaticRoute(path)).toBe(false)
  })
})
