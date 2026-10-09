import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { PrivateFeedSettings } from '@/components/settings/private-feed-settings'
import { snapshot } from './private-feed-mocks'
import { VariantEditorFixture } from './variant-editor-fixture'

declare global {
  interface Window {
    privateFeedTestSnapshot: typeof snapshot
  }
}
window.privateFeedTestSnapshot = snapshot

const root = document.getElementById('root')
if (!root) throw new Error('Component fixture root is missing')
const fixture = new URLSearchParams(window.location.search).get('fixture')
createRoot(root).render(
  fixture === 'variant-editor' || fixture === 'variant-editor-legacy' ? (
    <VariantEditorFixture legacy={fixture === 'variant-editor-legacy'} />
  ) : (
    <>
      <h1>Isolated private-feed regression fixture (mocked chain and vault)</h1>
      <PrivateFeedSettings />
      <Toaster toastOptions={{ duration: Infinity }} />
    </>
  )
)
