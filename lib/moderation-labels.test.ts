import { describe, expect, it } from 'vitest'
import { INTERIM_LABELS, hiddenStubText, labelOptions, labelText, moderationLabelLines, reasonInSentence, relativeTime } from './moderation-labels'

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
const CHARTER = [
  { id: 'R1', code: 'SPM', label: 'Spam' },
  { id: 'R2', code: 'HAR', label: 'Harassment' },
  { id: 'R3', code: 'CSA', label: '' },
]

describe('labels a moderator picks from', () => {
  it('numbers the seated charter\'s reasons by their place, citing each reason document', () => {
    expect(labelOptions(CHARTER)).toEqual([
      { label: 1, text: 'Spam', reasonDocumentId: 'R1' },
      { label: 2, text: 'Harassment', reasonDocumentId: 'R2' },
      { label: 3, text: 'CSA', reasonDocumentId: 'R3' },
    ])
  })

  it('offers the interim classes (report reasons, code + 1) while no team is seated, and nothing for an empty charter', () => {
    expect(labelOptions(null)).toBe(INTERIM_LABELS)
    expect(INTERIM_LABELS[0]).toEqual({ label: 1, text: 'Spam or scam' })
    expect(INTERIM_LABELS.every((option) => option.label >= 1 && option.label <= 63)).toBe(true)
    expect(labelOptions([])).toEqual([])
  })

  it('reads a label back as its reason, or null (never a number) when nothing explains it', () => {
    expect(labelText(2, CHARTER)).toBe('Harassment')
    expect(labelText(1, null)).toBe('Spam or scam')
    expect(labelText(9, CHARTER)).toBeNull()
    expect(labelText(undefined, CHARTER)).toBeNull()
  })
})

describe('the label a hidden or restricted item carries', () => {
  const hidden = { mod: 1, modLabel: 1, moderatedBy: 'M', moderatedAt: NOW - 2 * 3600_000 }

  it('reads "Hidden · reason · by · when"', () => {
    expect(moderationLabelLines({ marks: hidden, reasonText: 'Spam', moderatorName: '@alice', now: NOW })).toEqual(['Hidden · Spam · by @alice · 2h ago'])
  })

  it('says "Hidden by moderators" when neither the reason nor the moderator is known', () => {
    expect(moderationLabelLines({ marks: hidden, now: NOW })).toEqual(['Hidden by moderators · 2h ago'])
    expect(moderationLabelLines({ marks: { mod: 1 }, now: NOW })).toEqual(['Hidden by moderators'])
  })

  it('names a legal hold and a restricted author, and nothing for a listed item', () => {
    expect(moderationLabelLines({ marks: { mod: 2 }, now: NOW })).toEqual(['Hidden for legal reasons'])
    expect(moderationLabelLines({ restricted: true })).toEqual(['Restricted account'])
    expect(moderationLabelLines({ marks: { mod: 1 }, restricted: true, reasonText: 'Spam', now: NOW })).toEqual(['Hidden · Spam', 'Restricted account'])
    expect(moderationLabelLines({ marks: { modLabel: 3 } })).toEqual([])
    expect(moderationLabelLines({})).toEqual([])
  })

  it('never says removed or deleted', () => {
    const all = [
      ...moderationLabelLines({ marks: hidden, restricted: true, reasonText: 'Spam', moderatorName: '@a', now: NOW }),
      hiddenStubText('post', 'Spam'), hiddenStubText('reply', null), hiddenStubText('review', null, true),
    ].join(' ')
    expect(all).not.toMatch(/removed|deleted|barred|banned/i)
  })
})

describe('the stub someone who does not moderate sees', () => {
  it('is calm and gives the reason in the sentence', () => {
    expect(hiddenStubText('post', 'Spam or scam')).toBe('This post is hidden by moderators for spam or scam.')
    expect(hiddenStubText('reply', null)).toBe('This reply is hidden by moderators.')
    expect(hiddenStubText('listing', 'CSAM')).toBe('This listing is hidden by moderators for CSAM.')
    expect(hiddenStubText('post', 'Spam', true)).toBe('This post is hidden by moderators for legal reasons.')
  })

  it('keeps an acronym\'s case', () => {
    expect(reasonInSentence('NSFW media')).toBe('NSFW media')
    expect(reasonInSentence('Hate')).toBe('hate')
  })
})

describe('relativeTime', () => {
  it('reads short, then as a date', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
    expect(relativeTime(NOW - 30 * 86_400_000, NOW)).toBe('Sep 22')
  })
})
