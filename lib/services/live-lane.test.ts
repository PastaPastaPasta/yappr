import { beforeEach, describe, expect, it, vi } from 'vitest'

const { isRestricted, refresh } = vi.hoisted(() => ({ isRestricted: vi.fn(), refresh: vi.fn() }))
vi.mock('./restriction-service', () => ({ restrictionService: { isRestricted, refresh } }))

const OWNER = '11111111111111111111111111111113'
const LANE_REFUSED = new Error('Document does not satisfy restrictedLane (code=10422)')

async function createOn(topology: string, kind: 'post' | 'reply', create: (data: Record<string, unknown>) => Promise<string>, data: Record<string, unknown> = { content: 'hello' }) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  const { createInLiveLane } = await import('./live-lane')
  return createInLiveLane(kind, OWNER, data, create)
}

beforeEach(() => {
  isRestricted.mockReset().mockResolvedValue(false)
  refresh.mockReset().mockResolvedValue(null)
})

describe('createInLiveLane', () => {
  it.each(['post', 'reply'] as const)('writes live 1 for a %s by an author in good standing on v18', async (kind) => {
    const create = vi.fn().mockResolvedValue('ok')
    await expect(createOn('v18', kind, create)).resolves.toBe('ok')
    expect(create).toHaveBeenCalledExactlyOnceWith({ content: 'hello', live: 1 })
  })

  it.each(['post', 'reply'] as const)('writes live 2 for a %s by a restricted author on v18', async (kind) => {
    isRestricted.mockResolvedValue(true)
    const create = vi.fn().mockResolvedValue('ok')
    await createOn('v18', kind, create)
    expect(create).toHaveBeenCalledExactlyOnceWith({ content: 'hello', live: 2 })
  })

  it('still writes true on v17 and reads no standing', async () => {
    const create = vi.fn().mockResolvedValue('ok')
    await createOn('v17', 'post', create)
    expect(create).toHaveBeenCalledExactlyOnceWith({ content: 'hello', live: true })
    expect(isRestricted).not.toHaveBeenCalled()
  })

  it('writes no marker on a cut before v13', async () => {
    const create = vi.fn().mockResolvedValue('ok')
    await createOn('v12', 'post', create)
    expect(create).toHaveBeenCalledExactlyOnceWith({ content: 'hello' })
  })

  it('re-reads the standing after a refusal and writes once more with the corrected lane', async () => {
    refresh.mockResolvedValue({ state: 1 })
    const create = vi.fn().mockRejectedValueOnce(LANE_REFUSED).mockResolvedValueOnce('ok')

    await expect(createOn('v18', 'post', create)).resolves.toBe('ok')

    expect(refresh).toHaveBeenCalledExactlyOnceWith(OWNER)
    expect(create.mock.calls.map(([data]) => data.live)).toEqual([1, 2])
  })

  it('corrects a restriction that was lifted since it was read', async () => {
    isRestricted.mockResolvedValue(true)
    refresh.mockResolvedValue({ state: 2 })
    const create = vi.fn().mockRejectedValueOnce(LANE_REFUSED).mockResolvedValueOnce('ok')

    await createOn('v18', 'reply', create)

    expect(create.mock.calls.map(([data]) => data.live)).toEqual([2, 1])
  })

  it('retries only once, and rethrows the second refusal', async () => {
    refresh.mockResolvedValue({ state: 1 })
    const create = vi.fn().mockRejectedValue(LANE_REFUSED)

    await expect(createOn('v18', 'post', create)).rejects.toBe(LANE_REFUSED)

    expect(create).toHaveBeenCalledTimes(2)
  })

  it('rethrows a refusal the standing does not explain, without a second write', async () => {
    const create = vi.fn().mockRejectedValue(LANE_REFUSED)

    await expect(createOn('v18', 'post', create)).rejects.toBe(LANE_REFUSED)

    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not look at the standing for a failure that is not a refusal', async () => {
    const failure = new Error('network down')
    const create = vi.fn().mockRejectedValue(failure)

    await expect(createOn('v18', 'post', create)).rejects.toBe(failure)

    expect(refresh).not.toHaveBeenCalled()
  })

  it('writes the listed lane when the standing cannot be read, and lets a refusal correct it', async () => {
    isRestricted.mockRejectedValue(new Error('DAPI unavailable'))
    refresh.mockResolvedValue({ state: 1 })
    const create = vi.fn().mockRejectedValueOnce(LANE_REFUSED).mockResolvedValueOnce('ok')

    await createOn('v18', 'post', create)

    expect(create.mock.calls.map(([data]) => data.live)).toEqual([1, 2])
  })
})

describe('createInLiveLane and mentions', () => {
  const mention = new Uint8Array(32).fill(7)
  const withMention = { content: 'hi @alice', mentionedUserIds: [mention] }

  it.each(['post', 'reply'] as const)('keeps the mentions of a %s in lane 1', async (kind) => {
    const create = vi.fn().mockResolvedValue('ok')
    await createOn('v18', kind, create, withMention)
    expect(create).toHaveBeenCalledExactlyOnceWith({ ...withMention, live: 1 })
  })

  it.each(['post', 'reply'] as const)('writes the %s of a restricted author with its @name as text and no mentions', async (kind) => {
    isRestricted.mockResolvedValue(true)
    const create = vi.fn().mockResolvedValue('ok')
    await createOn('v18', kind, create, withMention)
    expect(create).toHaveBeenCalledExactlyOnceWith({ content: 'hi @alice', live: 2 })
  })

  it('does not change the caller\'s data', async () => {
    isRestricted.mockResolvedValue(true)
    await createOn('v18', 'post', vi.fn().mockResolvedValue('ok'), withMention)
    expect(withMention).toHaveProperty('mentionedUserIds')
  })

  it.each(['post', 'reply'] as const)('drops the mentions of a %s when the retry flips it to lane 2', async (kind) => {
    refresh.mockResolvedValue({ state: 1 })
    const create = vi.fn().mockRejectedValueOnce(LANE_REFUSED).mockResolvedValueOnce('ok')

    await createOn('v18', kind, create, withMention)

    expect(create.mock.calls.map(([data]) => data)).toEqual([
      { ...withMention, live: 1 },
      { content: 'hi @alice', live: 2 },
    ])
  })

  it.each(['post', 'reply'] as const)('keeps the mentions of a %s when the retry flips it to lane 1', async (kind) => {
    isRestricted.mockResolvedValue(true)
    refresh.mockResolvedValue({ state: 2 })
    const create = vi.fn().mockRejectedValueOnce(LANE_REFUSED).mockResolvedValueOnce('ok')

    await createOn('v18', kind, create, withMention)

    expect(create.mock.calls.map(([data]) => data)).toEqual([
      { content: 'hi @alice', live: 2 },
      { ...withMention, live: 1 },
    ])
  })
})
