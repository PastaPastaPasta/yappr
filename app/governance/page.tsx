'use client'

import { Sidebar } from '@/components/layout/sidebar'
import { RightSidebar } from '@/components/layout/right-sidebar'
import { ComposeModal } from '@/components/compose/compose-modal'
import { ScaleIcon } from '@heroicons/react/24/outline'

export default function GovernancePage() {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />

      <div className="flex-1 flex justify-center min-w-0">
        <main className="w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800">
          <header className="sticky top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-xl border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center gap-3 p-4">
              <ScaleIcon className="h-6 w-6" />
              <h1 className="text-xl font-bold">Governance</h1>
            </div>
          </header>

          {/* Placeholder content - will be replaced with GovernanceProposalList */}
          <div className="p-8 text-center">
            <ScaleIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Dash Network Governance</h2>
            <p className="text-gray-500 max-w-md mx-auto">
              View, discuss, and vote on Dash network governance proposals.
              This decentralized replacement for Dash Central allows masternode
              owners and community members to participate in network governance.
            </p>
            <p className="text-sm text-gray-400 mt-4">
              Coming soon: Proposal list, voting statistics, and community discussions.
            </p>
          </div>
        </main>
      </div>

      <RightSidebar />
      <ComposeModal />
    </div>
  )
}
