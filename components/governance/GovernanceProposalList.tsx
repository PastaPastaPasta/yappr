'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useAsyncState, LoadingState } from '@/components/ui/loading-state'
import { governanceService, type Proposal, type ProposalStatus } from '@/lib/services/governance-service'
import { GovernanceProposalCard } from './GovernanceProposalCard'

type TabType = 'all' | 'active' | 'passed' | 'funded' | 'failed'

const TABS: { id: TabType; label: string; status: ProposalStatus | null }[] = [
  { id: 'all', label: 'All', status: null },
  { id: 'active', label: 'Active', status: 'active' },
  { id: 'passed', label: 'Passed', status: 'passed' },
  { id: 'funded', label: 'Funded', status: 'funded' },
  { id: 'failed', label: 'Failed', status: 'failed' },
]

// Skeleton component matching ProposalCard layout
function ProposalCardSkeleton() {
  return (
    <div className="p-4 bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-xl">
      {/* Header: Name and Status */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="h-5 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-3/4" />
        <div className="h-5 w-16 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse shrink-0" />
      </div>

      {/* Amount and Link */}
      <div className="flex items-center gap-4 mb-3">
        <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-24" />
        <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-32" />
      </div>

      {/* Progress Bar */}
      <div className="h-2 bg-gray-200 dark:bg-gray-800 rounded-full animate-pulse w-full" />

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between">
        <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-28" />
        <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded animate-pulse w-16" />
      </div>
    </div>
  )
}

function LoadingSkeletons() {
  return (
    <div className="divide-y divide-gray-200 dark:divide-gray-800">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="p-4">
          <ProposalCardSkeleton />
        </div>
      ))}
    </div>
  )
}

interface GovernanceProposalListProps {
  className?: string
}

export function GovernanceProposalList({ className }: GovernanceProposalListProps) {
  // Simple state for active tab
  const [activeTab, setActiveTab] = useState<TabType>('active')

  // Separate state for each tab - null means "not yet loaded"
  const allState = useAsyncState<Proposal[]>(null)
  const activeState = useAsyncState<Proposal[]>(null)
  const passedState = useAsyncState<Proposal[]>(null)
  const fundedState = useAsyncState<Proposal[]>(null)
  const failedState = useAsyncState<Proposal[]>(null)

  // Map tabs to their state
  const stateMap = useMemo(() => ({
    all: allState,
    active: activeState,
    passed: passedState,
    funded: fundedState,
    failed: failedState,
  }), [allState, activeState, passedState, fundedState, failedState])

  // Handle tab change
  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab)
    // Update URL hash without triggering navigation
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${tab}`)
    }
  }, [])

  // Load data for a tab
  const loadTab = useCallback(async (tab: TabType, state: ReturnType<typeof useAsyncState<Proposal[]>>) => {
    const tabConfig = TABS.find(t => t.id === tab)

    state.setLoading(true)
    state.setError(null)

    try {
      let proposals: Proposal[]

      if (tabConfig?.status) {
        const result = await governanceService.getProposals({
          status: tabConfig.status,
          limit: 50,
        })
        proposals = result.documents
      } else {
        // "All" tab - get all proposals
        const result = await governanceService.getProposals({ limit: 50 })
        proposals = result.documents
      }

      // Sort by endEpoch descending for active, by createdAt for others
      proposals.sort((a, b) => {
        if (tab === 'active') {
          return a.endEpoch - b.endEpoch // Soonest deadline first
        }
        return b.createdAt.getTime() - a.createdAt.getTime() // Newest first
      })

      state.setData(proposals)
    } catch (error) {
      console.error(`Failed to load ${tab} proposals:`, error)
      state.setError(error instanceof Error ? error.message : 'Failed to load proposals')
    } finally {
      state.setLoading(false)
    }
  }, [])

  // Set initial tab from URL hash on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.slice(1) as TabType
      if (TABS.some(t => t.id === hash)) {
        setActiveTab(hash)
      }
    }
  }, [])

  // Load data when tab changes (only if not already loaded)
  useEffect(() => {
    const state = stateMap[activeTab]
    if (state.data === null && !state.loading) {
      void loadTab(activeTab, state)
    }
  }, [activeTab, stateMap, loadTab])

  const currentState = stateMap[activeTab]
  const proposals = currentState.data || []

  // Get empty state message based on tab
  const getEmptyMessage = (tab: TabType): string => {
    switch (tab) {
      case 'all': return 'No proposals found'
      case 'active': return 'No active proposals'
      case 'passed': return 'No passed proposals'
      case 'funded': return 'No funded proposals'
      case 'failed': return 'No failed proposals'
    }
  }

  const getEmptyDescription = (tab: TabType): string => {
    switch (tab) {
      case 'all': return 'There are no governance proposals on the network yet.'
      case 'active': return 'There are no proposals currently open for voting.'
      case 'passed': return 'No proposals have passed the funding threshold yet.'
      case 'funded': return 'No proposals have been funded yet.'
      case 'failed': return 'No proposals have failed to meet the funding threshold.'
    }
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Tab Navigation */}
      <div className="sticky top-[104px] z-30 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
        <div className="flex overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={cn(
                'flex-1 min-w-[80px] py-3 px-4 text-sm font-medium transition-colors relative whitespace-nowrap',
                activeTab === tab.id
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
              )}
            >
              {tab.label}
              {activeTab === tab.id && (
                <motion.div
                  layoutId="activeTab"
                  className="absolute bottom-0 left-1/2 -translate-x-1/2 w-12 h-1 bg-yappr-500 rounded-full"
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content Area */}
      {currentState.loading && currentState.data === null ? (
        <LoadingSkeletons />
      ) : (
        <LoadingState
          loading={false}
          error={currentState.error}
          isEmpty={proposals.length === 0}
          onRetry={() => void loadTab(activeTab, currentState)}
          emptyText={getEmptyMessage(activeTab)}
          emptyDescription={getEmptyDescription(activeTab)}
        >
          <div className="divide-y divide-gray-200 dark:divide-gray-800">
            {proposals.map((proposal, index) => (
              <motion.div
                key={proposal.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index * 0.05, 0.3) }}
                className="p-4"
              >
                <GovernanceProposalCard proposal={proposal} />
              </motion.div>
            ))}
          </div>
        </LoadingState>
      )}
    </div>
  )
}
