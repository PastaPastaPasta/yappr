'use client'

import { Sidebar } from '@/components/layout/sidebar'
import { LegacyMessages } from '@/components/messages/legacy-messages'
import { MessagesV5 } from '@/components/messages/messages-v5'
import { withAuth, useAuth } from '@/contexts/auth-context'
import { dmIsV5 } from '@/lib/constants'

function MessagesPage() {
  const { user } = useAuth()
  if (!dmIsV5()) return <LegacyMessages />
  return (
    <div className="h-[calc(100dvh-32px-56px)] md:h-[calc(100dvh-40px)] flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 md:max-w-[1200px] md:border-x border-gray-200 dark:border-gray-800 flex overflow-hidden">
        {user && <MessagesV5 identityId={user.identityId} />}
      </main>
    </div>
  )
}

export default withAuth(MessagesPage)
