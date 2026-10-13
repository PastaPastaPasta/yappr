/**
 * `validateDraft` on social v16: a post holds at most four tags, so a draft
 * whose first part names a fifth is refused before a ticket exists, as web's
 * composer refuses it (`tagLimitProblem`). A thread's later parts and a reply
 * carry no tags.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ')
const id = (tag: string) => tag.replace(/[0OIl]/g, 'z').padEnd(44, 'x')
const TARGET = { id: id('Target'), kind: 'post' as const, ownerId: id('Author'), rootPostId: null }

async function validateOn(topology: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_CONTRACT_TOPOLOGY', topology)
  return (await import('../../src/writes/publish')).validateDraft
}

afterEach(() => vi.unstubAllEnvs())

describe('validateDraft tags', () => {
  it('refuses a v16 post naming more than 4 tags, and nothing else', async () => {
    const validateDraft = await validateOn('v16')
    expect(() => validateDraft({ parts: [{ text: tags(4) }] })).not.toThrow()
    expect(() => validateDraft({ parts: [{ text: tags(5) }] })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
    // Only the first part is a post; a reply carries no tags.
    expect(() => validateDraft({ parts: [{ text: 'one' }, { text: tags(5) }] })).not.toThrow()
    expect(() => validateDraft({ parts: [{ text: tags(5) }], replyTo: TARGET })).not.toThrow()
  })

  it('refuses nothing before v16, where a post indexes its first tag', async () => {
    const validateDraft = await validateOn('v15')
    expect(() => validateDraft({ parts: [{ text: tags(5) }] })).not.toThrow()
  })
})
