import { describe, expect, it } from 'vitest'
import { DEFAULT_MASTERNODE_VOTE_URL, contractFromParam, inviteUrl, masternodeVoteUrl, teamsHref } from './links'

const TARGET = 'CzXucVEs1111111111111111111111111111111111'
const CHARTERS = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88'

describe('Moderation teams links', () => {
  it('names contracts social, blog and store in the address', () => {
    expect(contractFromParam('social')).toBe('social')
    expect(contractFromParam('blog')).toBe('blog')
    expect(contractFromParam('store')).toBe('storefront')
    expect(contractFromParam('storefront')).toBe('storefront')
    expect(contractFromParam('dm')).toBeNull()
    expect(contractFromParam(null)).toBeNull()
  })

  it('stays on one static route, with query parameters only', () => {
    expect(teamsHref('storefront')).toBe('/moderation-teams/?contract=store')
    expect(teamsHref('social', { proposal: 'abc' })).toBe('/moderation-teams/?contract=social&proposal=abc')
    expect(teamsHref('blog', { start: true })).toBe('/moderation-teams/?contract=blog&start=1')
    expect(inviteUrl('social', 'abc', 'https://yap.pr', '/staging/')).toBe('https://yap.pr/staging/moderation-teams/?contract=social&proposal=abc')
    expect(inviteUrl('social', 'abc', 'https://yap.pr', '')).toBe('https://yap.pr/moderation-teams/?contract=social&proposal=abc')
  })

  it('links masternode voting to vote.dashhq.org, or to a configured address with placeholders', () => {
    expect(masternodeVoteUrl(TARGET, CHARTERS, undefined)).toBe(DEFAULT_MASTERNODE_VOTE_URL)
    expect(masternodeVoteUrl(TARGET, CHARTERS, '  ')).toBe(DEFAULT_MASTERNODE_VOTE_URL)
    expect(masternodeVoteUrl(TARGET, CHARTERS, 'https://vote.dashhq.org/v2/contests/{charters}/{documentType}/{index}/{contract}'))
      .toBe(`https://vote.dashhq.org/v2/contests/${CHARTERS}/electedCharter/byTargetContract/${TARGET}`)
    expect(masternodeVoteUrl(TARGET, CHARTERS, 'https://vote.example/?poll={contract}')).toBe(`https://vote.example/?poll=${TARGET}`)
  })
})
