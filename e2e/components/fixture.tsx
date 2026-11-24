import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import { PrivateFeedSettings } from '@/components/settings/private-feed-settings'
import { snapshot } from './private-feed-mocks'
import { VariantEditorFixture } from './variant-editor-fixture'
import { LiveThreadStatusFixture, ThreadStatusFixture } from './thread-status-fixture'
import { BlogManagementFixture } from './blog-management-fixture'
import { BlogEditorFixture } from './blog-editor-fixture'
import { PasskeyEnrolFixture } from './passkey-enrol-fixture'
import { EncryptionKeyModalFixture, signInWithLoginKey } from './encryption-key-modal-fixture'
import { SetUpMessagingFixture } from './set-up-messaging-fixture'
import { PaymentModalFixture } from './payment-modal-fixture'

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
if (fixture === 'encryption-key-modal' || fixture === 'set-up-messaging') signInWithLoginKey()
const threadState = fixture?.startsWith('thread-') ? fixture.slice('thread-'.length) : null
const params = new URLSearchParams(window.location.search)
createRoot(root).render(
  fixture === 'buy-yapp' || fixture === 'tip' ? (
    <PaymentModalFixture modal={fixture === 'tip' ? 'tip' : 'buy'} signing={params.get('signing') === 'local' ? 'local' : 'wallet'} />
  ) : fixture === 'passkey-enrol' ? (
    <PasskeyEnrolFixture />
  ) : fixture === 'encryption-key-modal' ? (
    <EncryptionKeyModalFixture />
  ) : fixture === 'set-up-messaging' ? (
    <SetUpMessagingFixture />
  ) : fixture === 'blog-management' ? (
    <BlogManagementFixture />
  ) : fixture === 'blog-editor' ? (
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
      <h1>Isolated private-feed regression fixture (mocked chain)</h1>
      <PrivateFeedSettings />
      <Toaster toastOptions={{ duration: Infinity }} />
    </>
  )
)
