import { afterEach, describe, expect, it, vi } from 'vitest'
import { creditTipsEnabled, isBeta } from './feature-flags'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isBeta', () => {
  it('labels Store and Blog Beta by default', () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_STORE', '')
    vi.stubEnv('NEXT_PUBLIC_FEATURE_BLOG', '')
    expect(isBeta('store')).toBe(true)
    expect(isBeta('blog')).toBe(true)
  })

  it('drops the label only for ga, per product', () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_STORE', ' ga ')
    vi.stubEnv('NEXT_PUBLIC_FEATURE_BLOG', 'beta')
    expect(isBeta('store')).toBe(false)
    expect(isBeta('blog')).toBe(true)
  })
})

describe('creditTipsEnabled', () => {
  it('follows the login protocol when unset', () => {
    vi.stubEnv('NEXT_PUBLIC_FEATURE_CREDIT_TIPS', '')
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', 'app-connect')
    expect(creditTipsEnabled()).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', '')
    expect(creditTipsEnabled()).toBe(true)
  })

  it('obeys an explicit on or off on either build', () => {
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', 'app-connect')
    vi.stubEnv('NEXT_PUBLIC_FEATURE_CREDIT_TIPS', 'on')
    expect(creditTipsEnabled()).toBe(true)
    vi.stubEnv('NEXT_PUBLIC_LOGIN_PROTOCOL', '')
    vi.stubEnv('NEXT_PUBLIC_FEATURE_CREDIT_TIPS', 'off')
    expect(creditTipsEnabled()).toBe(false)
  })
})
