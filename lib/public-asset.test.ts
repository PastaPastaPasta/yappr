import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicAsset } from './public-asset'

afterEach(() => vi.unstubAllEnvs())
describe('public images on subpath deployments (#741)', () => {
  it.each(['', '/devnet', '/testing', '/staging'])('resolves both brand mark files on %s', (base) => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', base)
    for (const name of ['mark', 'mark-dark']) expect(publicAsset(`/brand/${name}.svg`)).toBe(`${base}/brand/${name}.svg`)
  })
})
