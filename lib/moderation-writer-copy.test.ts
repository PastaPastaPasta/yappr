import { beforeEach, expect, it, vi } from 'vitest'
const { standing, toast } = vi.hoisted(() => ({ standing: vi.fn(), toast: vi.fn() }))
vi.mock('react-hot-toast', () => ({ default: { error: toast } }))
vi.mock('@/lib/services/moderation-service', () => ({ moderationServiceFor: () => ({ getStanding: standing }) }))
import { reportBarredWrite } from '@/components/moderation/barred-writer-notice'
beforeEach(() => { standing.mockReset(); toast.mockClear() })
it('explains the social posting restriction and preserves the recorded reason', async () => {
  standing.mockResolvedValue({ banned: true, banReason: 'Repeated harassment' })
  expect(reportBarredWrite({ code: 41107 }, 'writer')).toBe(true)
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('You are banned from posting on Yappr: Repeated harassment', { duration: 8000 }))
})
it('keeps the fallback understandable when standing cannot be read', async () => {
  standing.mockRejectedValue(new Error('offline'))
  reportBarredWrite({ code: 41107 }, 'writer')
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Moderators have restricted your account from posting on Yappr.'))
})
