import { describe, expect, it } from 'vitest'
import { documentRemovalTarget } from '@/hooks/use-moderator-remove-modal'
import { deletionPhase } from '@/lib/services/moderation-service'

describe('editable document removal windows', () => {
  it('uses the last edit so an old blog post edited recently remains open', () => {
    const now = 1_800_000_000_000
    const target = documentRemovalTarget('blog', 'blogPost', 'blog post', {
      id: 'post', createdAt: now - 30 * 86400000, updatedAt: now - 1000,
    }, 'Title')
    expect(deletionPhase(604800, target.createdAt, now)).toBe('open')
  })

  it('uses creation time for immutable comments', () => {
    const now = 1_800_000_000_000
    const target = documentRemovalTarget('blog', 'blogComment', 'comment', {
      id: 'comment', createdAt: now - 30 * 86400000,
    }, 'Comment')
    expect(deletionPhase(604800, target.createdAt, now)).toBe('settled')
  })
})
