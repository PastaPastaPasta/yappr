import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicAsset } from './public-asset'

afterEach(() => vi.unstubAllEnvs())
describe('public images on subpath deployments (#741)', () => {
  it.each(['', '/devnet', '/testing', '/staging'])('resolves both Dash badges on %s', (base) => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', base)
    for (const theme of ['light', 'dark']) expect(publicAsset(`/pbde-${theme}.png`)).toBe(`${base}/pbde-${theme}.png`)
  })
})
