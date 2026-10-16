import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { PrivateFeedSettings } from '@/components/settings/private-feed-settings'
import { snapshot } from './private-feed-mocks'
import { VariantEditorFixture } from './variant-editor-fixture'
import { LiveThreadStatusFixture, ThreadStatusFixture } from './thread-status-fixture'
import { BlogEditorFixture } from './blog-editor-fixture'

declare global {
  interface Window {
    privateFeedTestSnapshot: typeof snapshot
    readinessChecks: number
  }
}
window.privateFeedTestSnapshot = snapshot

const root = document.getElementById('root')
if (!root) throw new Error('Component fixture root is missing')
const fixture = new URLSearchParams(window.location.search).get('fixture')
const threadState = fixture?.startsWith('thread-') ? fixture.slice('thread-'.length) : null
createRoot(root).render(
  fixture === 'blog-editor' ? (
    <BlogEditorFixture />
  ) : fixture === 'variant-editor' || fixture === 'variant-editor-legacy' ? (
    <VariantEditorFixture legacy={fixture === 'variant-editor-legacy'} />
  ) : threadState === 'checking' || threadState === 'unreachable' || threadState === 'reachable' ? (
    <ThreadStatusFixture state={threadState} />
  ) : threadState === 'live-failed-then-ok' ? (
    <LiveThreadStatusFixture answers={[null, new Error('DAPI timeout'), true]} />
  ) : threadState === 'live-not-set-up-then-ok' ? (
    <LiveThreadStatusFixture answers={[false, null, true]} />
  ) : (
    <>
      <h1>Isolated private-feed regression fixture (mocked chain and vault)</h1>
      <PrivateFeedSettings />
      <Toaster toastOptions={{ duration: Infinity }} />
    </>
  )
)
