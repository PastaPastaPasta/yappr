'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ArrowLeftIcon, ScaleIcon } from '@heroicons/react/24/outline'
import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { ComposeModal } from '@/components/compose/compose-modal'
import { GovernanceProposalDetail } from '@/components/governance'
import { governanceService } from '@/lib/services/governance-service'
import type { Proposal } from '@/lib/types'

function ProposalDetailSkeleton() {
  return (
    <div className="divide-y divide-gray-200 dark:divide-gray-800 animate-pulse">
      {/* Header skeleton */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-3/4" />
          <div className="h-6 w-16 bg-gray-200 dark:bg-gray-800 rounded-full shrink-0" />
        </div>
        <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-1/2" />
      </div>

      {/* Payment section skeleton */}
      <div className="p-4">
        <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-32 mb-3" />
        <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-40 mb-3" />
        <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded w-full" />
      </div>

      {/* Vote progress skeleton */}
      <div className="p-4">
        <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-32 mb-3" />
        <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-full mb-4" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i}>
              <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-16 mb-2" />
              <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded w-12" />
            </div>
          ))}
        </div>
      </div>

      {/* Timeline skeleton */}
      <div className="p-4">
        <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-24 mb-3" />
        <div className="grid grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div key={i}>
              <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded w-20 mb-2" />
              <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ProposalDetailContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const hash = searchParams.get('hash')

  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hash) {
      setIsLoading(false)
      setError('No proposal hash provided')
      return
    }

    const loadProposal = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const data = await governanceService.getProposalByHash(hash)
        setProposal(data)
        if (!data) {
          setError('Proposal not found')
        }
      } catch (err) {
        console.error('Failed to load proposal:', err)
        setError(err instanceof Error ? err.message : 'Failed to load proposal')
      } finally {
        setIsLoading(false)
      }
    }

    void loadProposal()
  }, [hash])

  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          {/* Sticky Header */}
          <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center gap-4 px-4 py-3">
              <button
                onClick={() => router.back()}
                className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
              >
                <ArrowLeftIcon className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-2">
                <ScaleIcon className="h-5 w-5 text-gray-500" />
                <h1 className="text-xl font-bold">Proposal</h1>
              </div>
            </div>
          </header>

          {/* Content */}
          {isLoading ? (
            <ProposalDetailSkeleton />
          ) : error ? (
            <div className="p-8 text-center">
              <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center">
                <ScaleIcon className="h-6 w-6 text-red-600 dark:text-red-400" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {error === 'Proposal not found' ? 'Proposal Not Found' : 'Error Loading Proposal'}
              </h2>
              <p className="text-gray-500 dark:text-gray-400 mb-4">
                {error === 'Proposal not found'
                  ? 'This proposal may have been removed or the hash is invalid.'
                  : error === 'No proposal hash provided'
                    ? 'Please navigate to a proposal from the governance list.'
                    : error}
              </p>
              <button
                onClick={() => router.push('/governance')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
              >
                View all proposals
              </button>
            </div>
          ) : proposal ? (
            <GovernanceProposalDetail proposal={proposal} />
          ) : null}
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />
    </div>
  )
}

function LoadingFallback() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="p-2 -ml-2 rounded-full">
                <ArrowLeftIcon className="h-5 w-5" />
              </div>
              <div className="flex items-center gap-2">
                <ScaleIcon className="h-5 w-5 text-gray-500" />
                <h1 className="text-xl font-bold">Proposal</h1>
              </div>
            </div>
          </header>
          <ProposalDetailSkeleton />
        </main>
      </div>
      <RightSidebar />
    </div>
  )
}

export default function ProposalDetailPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ProposalDetailContent />
    </Suspense>
  )
}
