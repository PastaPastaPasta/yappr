import { beforeEach, describe, expect, it, vi } from 'vitest'

const election = vi.hoisted(() => ({ getSeatedTeamAndReasons: vi.fn() }))
const declared = vi.hoisted(() => ({ elected: true }))

vi.mock('./moderation-election-service', () => ({ moderationElectionService: election }))
vi.mock('@/lib/moderated-contracts', () => ({
  moderatedContract: (key: string) => ({ contractId: `${key}-id`, elected: () => (declared.elected ? {} : null) }),
}))

import { charterReasonText, charterReasonsFor, forgetCharterReasons, peekCharterReasonText } from './charter-reasons'

const REASONS = [{ id: 'R1', code: 'SPM', label: 'Spam' }, { id: 'R2', code: 'HAR', label: 'Harassment' }]

beforeEach(() => {
  forgetCharterReasons()
  election.getSeatedTeamAndReasons.mockReset()
  declared.elected = true
})

describe('charterReasonText', () => {
  it('resolves a label against the seated charter, reading it once per contract', async () => {
    election.getSeatedTeamAndReasons.mockResolvedValue({ seated: { leaderId: 'L' }, reasons: REASONS })
    expect(peekCharterReasonText('social', 2)).toBeUndefined()
    expect(await charterReasonText('social', 2)).toBe('Harassment')
    expect(await charterReasonText('social', 1)).toBe('Spam')
    expect(peekCharterReasonText('social', 1)).toBe('Spam')
    expect(election.getSeatedTeamAndReasons).toHaveBeenCalledTimes(1)
    expect(election.getSeatedTeamAndReasons).toHaveBeenCalledWith('social-id')
    await charterReasonText('blog', 1)
    expect(election.getSeatedTeamAndReasons).toHaveBeenLastCalledWith('blog-id')
  })

  it('is null, never a number, when the charter does not list the label', async () => {
    election.getSeatedTeamAndReasons.mockResolvedValue({ seated: { leaderId: 'L' }, reasons: REASONS })
    expect(await charterReasonText('social', 7)).toBeNull()
    expect(await charterReasonText('social', undefined)).toBeNull()
    expect(peekCharterReasonText('social', 7)).toBeNull()
  })

  it('reads the interim classes while no team is seated, and on a contract that is not elected', async () => {
    election.getSeatedTeamAndReasons.mockResolvedValue({ seated: null, reasons: [] })
    expect(await charterReasonText('social', 1)).toBe('Spam or scam')
    declared.elected = false
    expect(await charterReasonsFor('storefront')).toBeNull()
    expect(election.getSeatedTeamAndReasons).toHaveBeenCalledTimes(1)
  })

  it('answers null on a failed read and does not keep the failure', async () => {
    election.getSeatedTeamAndReasons.mockRejectedValueOnce(new Error('offline'))
    expect(await charterReasonText('social', 1)).toBeNull()
    expect(peekCharterReasonText('social', 1)).toBeUndefined()
    election.getSeatedTeamAndReasons.mockResolvedValue({ seated: { leaderId: 'L' }, reasons: REASONS })
    expect(await charterReasonText('social', 1)).toBe('Spam')
    expect(election.getSeatedTeamAndReasons).toHaveBeenCalledTimes(2)
  })
})
