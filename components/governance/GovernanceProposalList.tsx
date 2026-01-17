'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import { useAsyncState, LoadingState } from '@/components/ui/loading-state'
import { governanceService, type Proposal, type ProposalStatus } from '@/lib/services/governance-service'
import { GovernanceProposalCard } from './GovernanceProposalCard'

type TabType = 'all' | 'active' | 'passed' | 'funded' | 'failed' | 'expired'
type SortType = 'ending' | 'newest' | 'amount' | 'votes'

const TABS: { id: TabType; label: string; status: ProposalStatus | null }[] = [
  { id: 'all', label: 'All', status: null },
  { id: 'active', label: 'Active', status: 'active' },
  { id: 'passed', label: 'Passed', status: 'passed' },
  { id: 'funded', label: 'Funded', status: 'funded' },
  { id: 'failed', label: 'Failed', status: 'failed' },
  { id: 'expired', label: 'Expired', status: 'expired' },
]

const SORT_OPTIONS: { id: SortType; label: string; description: string }[] = [
  { id: 'ending', label: 'Ending Soon', description: 'By voting deadline' },
  { id: 'newest', label: 'Newest', description: 'By creation date' },
  { id: 'amount', label: 'Highest Amount', description: 'By payment amount' },
  { id: 'votes', label: 'Most Votes', description: 'By net votes' },
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

// Sort proposals by user-selected criteria
function sortProposals(proposals: Proposal[], sortBy: SortType): Proposal[] {
  return [...proposals].sort((a, b) => {
    switch (sortBy) {
      case 'ending':
        // Soonest deadline first
        return a.endEpoch - b.endEpoch
      case 'newest':
        // Newest first
        return b.createdAt.getTime() - a.createdAt.getTime()
      case 'amount':
        // Highest amount first
        return b.paymentAmount - a.paymentAmount
      case 'votes':
        // Highest net votes first
        return b.netVotes - a.netVotes
      default:
        return 0
    }
  })
}

interface GovernanceProposalListProps {
  className?: string
}

export function GovernanceProposalList({ className }: GovernanceProposalListProps) {
  // Simple state for active tab and sort
  const [activeTab, setActiveTab] = useState<TabType>('active')
  const [sortBy, setSortBy] = useState<SortType>('ending')
  const [showSortMenu, setShowSortMenu] = useState(false)

  // Separate state for each tab - null means "not yet loaded"
  const allState = useAsyncState<Proposal[]>(null)
  const activeState = useAsyncState<Proposal[]>(null)
  const passedState = useAsyncState<Proposal[]>(null)
  const fundedState = useAsyncState<Proposal[]>(null)
  const failedState = useAsyncState<Proposal[]>(null)
  const expiredState = useAsyncState<Proposal[]>(null)

  // Map tabs to their state
  const stateMap = useMemo(() => ({
    all: allState,
    active: activeState,
    passed: passedState,
    funded: fundedState,
    failed: failedState,
    expired: expiredState,
  }), [allState, activeState, passedState, fundedState, failedState, expiredState])

  // Update URL with tab and sort state
  const updateUrl = useCallback((tab: TabType, sort: SortType) => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams()
      params.set('tab', tab)
      params.set('sort', sort)
      window.history.replaceState(null, '', `?${params.toString()}`)
    }
  }, [])

  // Handle tab change
  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab)
    updateUrl(tab, sortBy)
  }, [sortBy, updateUrl])

  // Handle sort change
  const handleSortChange = useCallback((sort: SortType) => {
    setSortBy(sort)
    setShowSortMenu(false)
    updateUrl(activeTab, sort)
    // Clear cached data so it re-sorts on next load
    const state = stateMap[activeTab]
    if (state.data) {
      // Re-sort existing data immediately
      const sorted = sortProposals([...state.data], sort)
      state.setData(sorted)
    }
  }, [activeTab, stateMap, updateUrl])

  // Load data for a tab
  const loadTab = useCallback(async (tab: TabType, state: ReturnType<typeof useAsyncState<Proposal[]>>, sort: SortType) => {
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

      // Sort by user-selected criteria
      proposals = sortProposals(proposals, sort)

      state.setData(proposals)
    } catch (error) {
      console.error(`Failed to load ${tab} proposals:`, error)
      state.setError(error instanceof Error ? error.message : 'Failed to load proposals')
    } finally {
      state.setLoading(false)
    }
  }, [])

  // Set initial tab and sort from URL params on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      const tabParam = params.get('tab') as TabType | null
      const sortParam = params.get('sort') as SortType | null

      if (tabParam && TABS.some(t => t.id === tabParam)) {
        setActiveTab(tabParam)
      }
      if (sortParam && SORT_OPTIONS.some(s => s.id === sortParam)) {
        setSortBy(sortParam)
      }
    }
  }, [])

  // Load data when tab changes (only if not already loaded)
  useEffect(() => {
    const state = stateMap[activeTab]
    if (state.data === null && !state.loading) {
      void loadTab(activeTab, state, sortBy)
    }
  }, [activeTab, stateMap, loadTab, sortBy])

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
      case 'expired': return 'No expired proposals'
    }
  }

  const getEmptyDescription = (tab: TabType): string => {
    switch (tab) {
      case 'all': return 'There are no governance proposals on the network yet.'
      case 'active': return 'There are no proposals currently open for voting.'
      case 'passed': return 'No proposals have passed the funding threshold yet.'
      case 'funded': return 'No proposals have been funded yet.'
      case 'failed': return 'No proposals have failed to meet the funding threshold.'
      case 'expired': return 'No proposals have expired past their voting deadline.'
    }
  }

  // Get the current sort option label
  const currentSortOption = SORT_OPTIONS.find(s => s.id === sortBy) ?? SORT_OPTIONS[0]

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Tab Navigation */}
      <div className="sticky top-[104px] z-30 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between px-2">
          <div className="flex overflow-x-auto flex-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  'flex-1 min-w-[60px] py-3 px-3 text-sm font-medium transition-colors relative whitespace-nowrap',
                  activeTab === tab.id
                    ? 'text-gray-900 dark:text-white'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                )}
              >
                {tab.label}
                {activeTab === tab.id && (
                  <motion.div
                    layoutId="activeTab"
                    className="absolute bottom-0 left-1/2 -translate-x-1/2 w-10 h-1 bg-yappr-500 rounded-full"
                  />
                )}
              </button>
            ))}
          </div>

          {/* Sort Dropdown */}
          <div className="relative shrink-0">
            <button
              onClick={() => setShowSortMenu(!showSortMenu)}
              className="flex items-center gap-1 px-3 py-2 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
            >
              <span className="hidden sm:inline">Sort:</span>
              <span>{currentSortOption.label}</span>
              <ChevronDownIcon className={cn(
                'w-3 h-3 transition-transform',
                showSortMenu && 'rotate-180'
              )} />
            </button>

            {/* Sort Menu */}
            {showSortMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowSortMenu(false)}
                />
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50 overflow-hidden"
                >
                  {SORT_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      onClick={() => handleSortChange(option.id)}
                      className={cn(
                        'w-full text-left px-4 py-2.5 text-sm transition-colors',
                        sortBy === option.id
                          ? 'bg-yappr-50 dark:bg-yappr-900/30 text-yappr-700 dark:text-yappr-300'
                          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                      )}
                    >
                      <div className="font-medium">{option.label}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{option.description}</div>
                    </button>
                  ))}
                </motion.div>
              </>
            )}
          </div>
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
          onRetry={() => void loadTab(activeTab, currentState, sortBy)}
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
