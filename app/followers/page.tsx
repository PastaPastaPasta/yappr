'use client'

import { withAuth } from '@/contexts/auth-context'
import { ConnectionListPage } from '@/components/profile/connection-list-page'

function FollowersPage() {
  return <ConnectionListPage kind="followers" />
}

export default withAuth(FollowersPage, { optional: true })
