'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { PageHeader, PageShell } from '@/components/layout/page-shell'
import { TooltipButton } from '@/components/ui/tooltip-button'
import { useAuth } from '@/contexts/auth-context'
import { cn } from '@/lib/utils'
import { moderatedContract } from '@/lib/moderated-contracts'
import { charterService } from '@/lib/services/charter-service'
import { contractFromParam, electedContracts, teamsHref } from '@/lib/moderation-charters/links'
import { ElectionOverview } from './election-overview'
import { ProposalView } from './proposal-view'
import { StartTeamForm } from './start-team-form'
import { Notice, Section, useElectionStatus } from './shared'

/**
 * `/moderation-teams?contract=social|blog|store[&proposal=<id>|&start=1]`:
 * standing for election as a contract's moderation team. Each contract
 * (social, blog, store) has its own election; a tab picks which. Masternodes
 * vote elsewhere (vote.dashhq.org); this page links there.
 */
export function ModerationTeamsView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user } = useAuth()
  const contracts = electedContracts()
  const contract = contractFromParam(searchParams.get('contract'))
  const active = contract && contracts.includes(contract) ? contract : contracts[0]
  const proposalId = searchParams.get('proposal')
  const starting = searchParams.get('start') === '1'
  const election = useElectionStatus(active ? moderatedContract(active).contractId : '')

  // Keys typed in for charters live while this page does, and only for the account that gave them.
  useEffect(() => () => charterService.forgetKeys(), [])
  useEffect(() => { charterService.forgetKeys() }, [user?.identityId])

  return (
    <PageShell>
      <PageHeader>
        <div className="flex items-center gap-4 px-4 py-3">
          <TooltipButton label="Back" tooltipClassName="z-50" onClick={() => router.back()} className="-ml-2 border-0 dark:hover:bg-gray-900">
            <ArrowLeftIcon className="h-5 w-5" />
          </TooltipButton>
          <h1 className="text-xl font-bold">Moderation teams</h1>
        </div>
        {contracts.length > 1 && (
          <div role="tablist" aria-label="Contract" className="flex gap-2 px-4 pb-3">
            {contracts.map((key) => (
              <Link
                key={key}
                role="tab"
                aria-selected={key === active}
                href={teamsHref(key)}
                className={cn(
                  'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                  key === active
                    ? 'bg-yappr-500 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
                )}
              >
                {moderatedContract(key).label}
              </Link>
            ))}
          </div>
        )}
      </PageHeader>

      {!active ? (
        <Section><Notice>No contract on this site elects its moderators.</Notice></Section>
      ) : election.notElected ? (
        <Section><Notice>{moderatedContract(active).label} does not elect its moderators.</Notice></Section>
      ) : proposalId ? (
        <ProposalView key={`${active}:${proposalId}`} contract={active} proposalId={proposalId} election={election} />
      ) : starting ? (
        <StartTeamForm key={active} contract={active} status={election.status} />
      ) : (
        <ElectionOverview contract={active} election={election} />
      )}
    </PageShell>
  )
}
