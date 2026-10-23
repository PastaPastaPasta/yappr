/**
 * The Moderation teams page's addresses (a static route with query
 * parameters only) and the masternode voting link. Pure (unit-tested).
 */
import { MODERATED_CONTRACTS, moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'

/** The contracts this build serves whose moderators are elected: the page's tabs. */
export function electedContracts(): ModeratedContractKey[] {
  return MODERATED_CONTRACTS.filter((key) => {
    const declared = moderatedContract(key)
    return declared.contractId !== '' && declared.elected() !== null
  })
}

/** How the page's `?contract=` names each contract. */
const PARAM: Record<ModeratedContractKey, string> = { social: 'social', storefront: 'store', blog: 'blog' }

export function contractFromParam(value: string | null): ModeratedContractKey | null {
  if (value === 'storefront') return 'storefront'
  return MODERATED_CONTRACTS.find((key) => PARAM[key] === value) ?? null
}

/** The page for `contract`: its election, a proposal of it, or the form that starts a team. */
export function teamsHref(contract: ModeratedContractKey, view: { proposal?: string; start?: boolean } = {}): string {
  const query = new URLSearchParams({ contract: PARAM[contract] })
  if (view.proposal) query.set('proposal', view.proposal)
  if (view.start) query.set('start', '1')
  return `/moderation-teams/?${query.toString()}`
}

/** The link a leader shares so members can ask to join (absolute, on this deployment). */
export function inviteUrl(contract: ModeratedContractKey, proposalId: string, origin: string, basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''): string {
  return `${origin}${basePath.replace(/\/+$/, '')}${teamsHref(contract, { proposal: proposalId })}`
}

/** Where masternode owners vote; `NEXT_PUBLIC_MASTERNODE_VOTE_URL` overrides it. */
export const DEFAULT_MASTERNODE_VOTE_URL = 'https://vote.dashhq.org/'

/**
 * The masternode voting link for the contest over `targetContractId`. The
 * configured address may name the contest with placeholders: `{contract}`
 * (the target contract id), `{charters}` (the charters contract id),
 * `{documentType}` (`electedCharter`) and `{index}` (`byTargetContract`).
 * Without placeholders it is used as is (the voting site's front page).
 */
export function masternodeVoteUrl(targetContractId: string, chartersContractId: string, template = process.env.NEXT_PUBLIC_MASTERNODE_VOTE_URL): string {
  const base = template?.trim() || DEFAULT_MASTERNODE_VOTE_URL
  return base
    .replaceAll('{contract}', encodeURIComponent(targetContractId))
    .replaceAll('{charters}', encodeURIComponent(chartersContractId))
    .replaceAll('{documentType}', 'electedCharter')
    .replaceAll('{index}', 'byTargetContract')
}
