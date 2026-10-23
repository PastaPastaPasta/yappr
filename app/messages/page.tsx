'use client'

import { Sidebar } from '@/components/layout/sidebar'
import { ElectionBannerSlot } from '@/components/moderation/election-banner'
import { LegacyMessages } from '@/components/messages/legacy-messages'
import { MessagesV5 } from '@/components/messages/messages-v5'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { dmIsV5 } from '@/lib/constants'

function MessagesPage() {
  const { user } = useAuth()
  if (!dmIsV5()) return <LegacyMessages />
  return (
    <div className="h-[calc(100dvh-56px)] md:h-[100dvh] pt-[var(--page-pill-clearance,var(--network-pill-height,0px))] md:pt-0 flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 md:max-w-[1200px] md:border-x border-gray-200 dark:border-gray-800 flex flex-col overflow-hidden">
        <ElectionBannerSlot />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {user && <MessagesV5 identityId={user.identityId} />}
        </div>
      </main>
    </div>
  )
}

export default withAuth(MessagesPage)
