import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { PrivateFeedSettings } from '@/components/settings/private-feed-settings'
import { PrivateFeedFollowRequests } from '@/components/settings/private-feed-follow-requests'
import { PrivateFeedFollowers } from '@/components/settings/private-feed-followers'
import { snapshot, showSiblingPanels } from './private-feed-mocks'

declare global {
  interface Window {
    privateFeedTestSnapshot: typeof snapshot
  }
}
window.privateFeedTestSnapshot = snapshot

const root = document.getElementById('root')
if (!root) throw new Error('Component fixture root is missing')
createRoot(root).render(
  <>
    <h1>Isolated private-feed regression fixture (mocked chain and vault)</h1>
    <PrivateFeedSettings />
    {showSiblingPanels && (
      <>
        <PrivateFeedFollowRequests />
        <PrivateFeedFollowers />
      </>
    )}
    <Toaster toastOptions={{ duration: Infinity }} />
  </>
)
