'use client'

import { Suspense } from 'react'
import dynamic from 'next/dynamic'
import NotFound from '@/app/not-found'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/contexts/auth-context'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useModeratorView } from '@/hooks/use-moderator-view'

const ModerationLogView = dynamic(() => import('@/components/moderation-log/moderation-log-view').then((module) => module.ModerationLogView))

const loading = <div className="flex min-h-screen items-center justify-center"><Spinner size="md" /></div>

/**
 * `/moderation?view=hidden`: what the moderators have hidden and the accounts
 * restricted now, for the verified members of a seated team only, limited to
 * the contracts they moderate (social v18, blog v10, storefront v11). For
 * everyone else, the route is the same page as any address that does not
 * exist.
 */
export default function ModerationPage() {
  const { isAuthRestoring } = useAuth()
  const { seated, checking } = useModeratorView()
  // Named on the client only: to anyone else the route is a plain not-found page.
  useDocumentTitle(seated.length > 0 ? 'Hidden & restricted' : null)
  if (isAuthRestoring || checking) return loading
  if (seated.length === 0) return <NotFound />
  return (
    <Suspense fallback={loading}>
      <ModerationLogView variant="hidden" contracts={seated} />
    </Suspense>
  )
}
