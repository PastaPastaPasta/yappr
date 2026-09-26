import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/services/evo-sdk-service', () => ({
  evoSdkService: { initialize: async () => undefined, getSdk: async () => ({ documents: { query } }) },
}))

import { YAPPR_CONTRACT_ID, YAPPR_PROFILE_CONTRACT_ID } from '@/lib/constants'
import { createProfileGate, hasYapprProfile, isGateVisitCleared, isProfileOptionalRoute, nextGateVisit, usernameGateAction, type GateVisit } from './profile-gate'

const identityId = '11111111111111111111111111111111'
const profileDoc = { $id: 'p', $ownerId: identityId, displayName: 'Ava' }

const gated = { identityId, pathname: '/feed/' }

describe('isProfileOptionalRoute', () => {
  it('exempts the profile-less flows and the embed, with or without the trailing slash', () => {
    for (const route of ['/profile/create/', '/dpns/register', '/login/', '/welcome', '/embed/']) {
      expect(isProfileOptionalRoute(route)).toBe(true)
    }
  })

  it('exempts the legal and informational pages, and everything under /about', () => {
    for (const route of ['/terms/', '/privacy', '/cookies/', '/contract/', '/about', '/about/', '/about/private-feeds/']) {
      expect(isProfileOptionalRoute(route)).toBe(true)
    }
  })

  it('gates everything else, including routes that merely share a suffix or prefix', () => {
    for (const route of [
      '/', '/feed/', '/user/', '/post/', '/settings/', '/store/create/', '/profile/create/extra',
      '/aboutx/', '/terms/extra', '/contracts/', '/privacy-policy/',
    ]) {
      expect(isProfileOptionalRoute(route)).toBe(false)
    }
  })
})

describe('createProfileGate', () => {
  it('redirects a profile-less user on a gated route', async () => {
    const gate = createProfileGate(async () => false)
    await expect(gate.shouldRedirect(gated)).resolves.toBe(true)
  })

  it('leaves a user with a profile alone and does not ask again', async () => {
    const lookup = vi.fn(async () => true)
    const gate = createProfileGate(lookup)
    await expect(gate.shouldRedirect(gated)).resolves.toBe(false)
    await expect(gate.shouldRedirect({ ...gated, pathname: '/user/' })).resolves.toBe(false)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('rejects instead of redirecting when the lookup fails', async () => {
    const gate = createProfileGate(async () => {
      throw new Error('DAPI unavailable')
    })
    await expect(gate.shouldRedirect(gated)).rejects.toThrow('DAPI unavailable')
  })

  it('checks again after leaving an exempt route', async () => {
    const lookup = vi.fn(async () => false)
    const gate = createProfileGate(lookup)
    await expect(gate.shouldRedirect({ ...gated, pathname: '/login/' })).resolves.toBe(false)
    expect(lookup).not.toHaveBeenCalled()
    await expect(gate.shouldRedirect(gated)).resolves.toBe(true)
  })

  it('asks the network again after an absence, so a new profile lets the user through', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const gate = createProfileGate(lookup)
    await expect(gate.shouldRedirect(gated)).resolves.toBe(true)
    await expect(gate.shouldRedirect(gated)).resolves.toBe(false)
  })

  it('trusts a remembered profile that is not query-visible yet', async () => {
    const lookup = vi.fn(async () => false)
    const gate = createProfileGate(lookup)
    gate.rememberProfile(identityId)
    await expect(gate.shouldRedirect(gated)).resolves.toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('redirects a profile-less user from optional and required pages alike, never from its own flows or the info pages', async () => {
    const gate = createProfileGate(async () => false)
    for (const pathname of ['/feed/', '/post/', '/messages/', '/settings/']) {
      await expect(gate.shouldRedirect({ ...gated, pathname })).resolves.toBe(true)
    }
    for (const pathname of ['/profile/create/', '/dpns/register/', '/terms/', '/about/private-feeds/']) {
      await expect(gate.shouldRedirect({ ...gated, pathname })).resolves.toBe(false)
    }
  })
})

describe('gate visits', () => {
  const start: GateVisit = { identityId, pathname: '/settings/', seq: 0 }

  it('keeps the same visit while neither the identity nor the route changes', () => {
    expect(nextGateVisit(start, identityId, '/settings/')).toBe(start)
  })

  it('starts a new visit on a route change or an identity change', () => {
    expect(nextGateVisit(start, identityId, '/feed/').seq).toBe(1)
    expect(nextGateVisit(start, 'other', '/settings/').seq).toBe(1)
    expect(nextGateVisit(start, undefined, '/settings/').seq).toBe(1)
  })

  it('never clears a signed-out visit', () => {
    const signedOut: GateVisit = { identityId: undefined, pathname: '/feed/', seq: 3 }
    expect(isGateVisitCleared(signedOut, signedOut)).toBe(false)
  })

  it('does not reuse a failed-open clearance after a trip through an exempt route and back', async () => {
    // The provider's sequence: the lookup fails open on /settings, withAuth sends
    // the user to /dpns/register (exempt, so nothing is cleared there), and the
    // user returns to /settings, where the lookup now succeeds and finds nothing.
    const lookup = vi.fn()
      .mockRejectedValueOnce(new Error('DAPI unavailable'))
      .mockResolvedValueOnce(false)
    const gate = createProfileGate(lookup)
    const noUsername = { usernameOptional: false, username: undefined, skippedUsername: false }

    const settings = start
    await expect(gate.shouldRedirect({ identityId, pathname: settings.pathname })).rejects.toThrow()
    const cleared = settings // fail open: this visit is cleared
    expect(usernameGateAction({ ...noUsername, profileCleared: isGateVisitCleared(cleared, settings) })).toBe('redirect')

    const dpns = nextGateVisit(settings, identityId, '/dpns/register/')
    await expect(gate.shouldRedirect({ identityId, pathname: dpns.pathname })).resolves.toBe(false)

    const back = nextGateVisit(dpns, identityId, '/settings/')
    // First render back on /settings, while the new lookup is still pending.
    expect(isGateVisitCleared(cleared, back)).toBe(false)
    expect(usernameGateAction({ ...noUsername, profileCleared: isGateVisitCleared(cleared, back) })).toBe('wait')
    // The lookup then finds no profile: the profile gate, not DPNS, wins.
    await expect(gate.shouldRedirect({ identityId, pathname: back.pathname })).resolves.toBe(true)
  })
})

describe('usernameGateAction', () => {
  const noUsername = { usernameOptional: false, username: undefined, skippedUsername: false }

  it('holds a user without a username until the profile gate clears them, so /profile/create comes first', () => {
    expect(usernameGateAction({ ...noUsername, profileCleared: false })).toBe('wait')
    expect(usernameGateAction({ ...noUsername, profileCleared: true })).toBe('redirect')
  })

  it('lets through a username, a skip, or a page that does not need one', () => {
    for (const profileCleared of [false, true]) {
      expect(usernameGateAction({ ...noUsername, profileCleared, username: 'ava.dash' })).toBe('none')
      expect(usernameGateAction({ ...noUsername, profileCleared, skippedUsername: true })).toBe('none')
      expect(usernameGateAction({ ...noUsername, profileCleared, usernameOptional: true })).toBe('none')
    }
  })
})

describe('hasYapprProfile', () => {
  beforeEach(() => {
    query.mockReset()
  })

  it('finds a unified profile without querying the legacy contract', async () => {
    query.mockResolvedValueOnce(new Map([['p', profileDoc]]))
    await expect(hasYapprProfile(identityId)).resolves.toBe(true)
    expect(query).toHaveBeenCalledExactlyOnceWith({
      dataContractId: YAPPR_PROFILE_CONTRACT_ID,
      documentTypeName: 'profile',
      where: [['$ownerId', '==', identityId]],
      limit: 1,
    })
  })

  it('falls back to a legacy profile on the social contract', async () => {
    query.mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map([['p', profileDoc]]))
    await expect(hasYapprProfile(identityId)).resolves.toBe(true)
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ dataContractId: YAPPR_CONTRACT_ID }))
  })

  it('reports absence only when both queries succeed empty', async () => {
    query.mockResolvedValue(new Map())
    await expect(hasYapprProfile(identityId)).resolves.toBe(false)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('rejects when either query fails rather than reporting absence', async () => {
    query.mockRejectedValueOnce(new Error('unified query failed'))
    await expect(hasYapprProfile(identityId)).rejects.toThrow('unified query failed')

    query.mockResolvedValueOnce(new Map()).mockRejectedValueOnce(new Error('legacy query failed'))
    await expect(hasYapprProfile(identityId)).rejects.toThrow('legacy query failed')
  })
})
