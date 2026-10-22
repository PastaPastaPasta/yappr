import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  moderatedTypeOpen: vi.fn(),
  getStatus: vi.fn(),
}))

vi.mock('@/lib/services/moderation-service', async (load) => ({
  ...await load<object>(),
  moderationServiceFor: () => ({ moderatedTypeOpen: m.moderatedTypeOpen }),
}))
vi.mock('@/lib/services/moderation-election-service', async (load) => ({
  ...await load<object>(),
  moderationElectionService: { getStatus: m.getStatus },
}))

const { moderation, forgetPostingOpening } = await import('../../src/api/moderation')
const { platformInfo } = await import('../../src/dto/capabilities')

const status = (overrides: Record<string, unknown> = {}) => ({
  declaration: { interim: 'notYetUsable' },
  seated: null,
  contest: null,
  failures: [],
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  forgetPostingOpening()
})

describe('moderation.postingOpening', () => {
  it('is open without the election walk when the type is open (a team is seated)', async () => {
    m.moderatedTypeOpen.mockResolvedValue(true)
    expect(await moderation.postingOpening()).toEqual({ kind: 'open' })
    expect(m.moderatedTypeOpen).toHaveBeenCalledWith('post')
    expect(m.getStatus).not.toHaveBeenCalled()
  })

  it('gives the contest\'s end as the date posting opens', async () => {
    m.moderatedTypeOpen.mockResolvedValue(false)
    const end = Date.now() + 3_600_000
    m.getStatus.mockResolvedValue(status({ contest: { winner: null, endsAtMs: end } }))
    expect(await moderation.postingOpening()).toEqual({ kind: 'at', atMs: end })
  })

  it('says soon once the contest is decided, pending with no charter, unknown when the seat could not be read', async () => {
    m.moderatedTypeOpen.mockResolvedValue(false)
    m.getStatus.mockResolvedValueOnce(status({ contest: { winner: {}, endsAtMs: null } }))
    expect(await moderation.postingOpening()).toEqual({ kind: 'soon' })
    forgetPostingOpening()
    m.getStatus.mockResolvedValueOnce(status())
    expect(await moderation.postingOpening()).toEqual({ kind: 'pending' })
    forgetPostingOpening()
    m.getStatus.mockResolvedValueOnce(status({ failures: ['seatedTeam'] }))
    expect(await moderation.postingOpening()).toEqual({ kind: 'unknown' })
  })

  it('shares one answer for a minute, and does not keep a failure', async () => {
    m.moderatedTypeOpen.mockResolvedValue(false)
    m.getStatus.mockResolvedValue(status())
    await moderation.postingOpening()
    await moderation.postingOpening()
    expect(m.getStatus).toHaveBeenCalledTimes(1)

    forgetPostingOpening()
    m.moderatedTypeOpen.mockRejectedValueOnce(new Error('offline'))
    await expect(moderation.postingOpening()).rejects.toThrow('offline')
    await expect(moderation.postingOpening()).resolves.toEqual({ kind: 'pending' })
  })
})

describe('capabilities for moderation', () => {
  it('reports whether posting may be closed by an interim, and whether moderators hide', () => {
    const { capabilities } = platformInfo()
    expect(typeof capabilities.postingMayBeClosed).toBe('boolean')
    expect(typeof capabilities.moderatorsHide).toBe('boolean')
    expect(typeof capabilities.storefrontModeratorsHide).toBe('boolean')
  })
})
