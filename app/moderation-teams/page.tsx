'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import { Spinner } from '@/components/ui/spinner'

const ModerationTeamsView = dynamic(() => import('@/components/moderation-teams/moderation-teams-view').then((module) => module.ModerationTeamsView))

/** `/moderation-teams`: stand for election as a contract's moderation team, or join one. */
export default function ModerationTeamsPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Spinner size="md" /></div>}>
      <ModerationTeamsView />
    </Suspense>
  )
}
