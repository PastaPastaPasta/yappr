'use client'

import { withAuth } from '@/contexts/auth-context'
import { ConnectionListPage } from '@/components/profile/connection-list-page'

function FollowingPage() {
  return <ConnectionListPage kind="following" />
}

export default withAuth(FollowingPage, { optional: true })
