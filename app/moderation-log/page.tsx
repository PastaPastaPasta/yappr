'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import NotFound from '@/app/not-found'
import { Spinner } from '@/components/ui/spinner'
import { moderationLogEnabled } from '@/lib/moderation-view'

// The log's code loads only when the build serves it: a release build exports
// this route as the not-found page and never fetches the view.
const ModerationLogView = dynamic(() => import('@/components/moderation-log/moderation-log-view').then((module) => module.ModerationLogView))

/**
 * `/moderation-log`: the moderation log of an archival frontend
 * (docs/ARCHIVE_FRONTEND.md). Off by default (`NEXT_PUBLIC_MODERATION_LOG=1`
 * turns it on; release builds refuse the flag), and nothing links to it: where
 * it is off, the route is the same page as any address that does not exist.
 */
export default function ModerationLogPage() {
  if (!moderationLogEnabled()) return <NotFound />
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Spinner size="md" /></div>}>
      <ModerationLogView />
    </Suspense>
  )
}
