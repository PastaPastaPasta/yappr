import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import type { ReplyThread } from '@/lib/types'
// Bypass the page fixture's mocked @/hooks/use-post-detail alias.
import { usePostDetail as useRealPostDetail } from '../../hooks/use-post-detail'
import { Toaster } from 'react-hot-toast'
import InventoryPage from '@/app/store/inventory/page'
import UserPage from '@/app/user/page'
import MessagesPage from '@/app/messages/page'
import PostPage from '@/app/post/page'
import CheckoutPage from '@/app/checkout/page'
import ManagePage from '@/app/store/manage/page'
import StorePage from '@/app/store/view/page'
import { NetworkPill } from '@/components/layout/network-pill'
import { ThreadPostEditor } from '@/components/compose/thread-post-editor'
import { StatusUpdateForm } from '@/components/orders/status-update-form'
import { ConversationList } from '@/components/messages/conversation-list'
import { GroupSettingsDialog } from '@/components/messages/group-settings-dialog'
import { PrivateFeedDashboard } from '@/components/settings/private-feed-dashboard'
import { InventoryTable } from '@/components/store/inventory-table'
import { EMPTY_DRAFT } from '@/components/profile/profile-edit-form'
import { ProfileHeader } from '@/components/profile/profile-header'
import { details, row, eurItem } from './qa-round1-mocks'
import { storeEncryptionKey } from '@/lib/secure-storage'
import '@/app/globals.css'
const noop = () => undefined
const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture')
function threadContents(threads: ReplyThread[]): string[] {
  return threads.flatMap(thread => [thread.content.content, ...threadContents(thread.nestedReplies)]).filter(Boolean)
}
function PostRecoveryFixture() {
  const detail = useRealPostDetail({ postId: 'post' })
  return <>
    <div data-testid="hook-post">{detail.post?.id}</div>
    <div data-testid="hook-error">{detail.error}</div>
    <div data-testid="hook-replies">{threadContents(detail.replyThreads).join(',')}</div>
    <div data-testid="hook-loading">{String(detail.isLoading || detail.isLoadingReplies)}</div>
    <button onClick={detail.refresh}>Refresh thread</button>
    <button onClick={detail.loadMoreReplies}>Load more replies</button>
  </>
}
// Public scalar 1, for the offline checkout readiness check only.
storeEncryptionKey('buyer', 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA')
function InboxFixture() {
  const [hidden, setHidden] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  return <><button onClick={() => setHidden(true)}>Delete fixture conversation</button><ConversationList rows={[{ ...row, hidden }]} selectedKey={null} details={details} isLoading={false} showHidden={showHidden} onToggleHidden={() => setShowHidden(!showHidden)} onSelect={noop} onNewMessage={noop} onNewGroup={noop} onOpenSettings={noop} /></>
}
function GroupFixture() {
  return <GroupSettingsDialog open onOpenChange={noop} viewerId="owner" details={details} group={{ ...row, isOwner: true, lastMessage: null, unsaved: false, unreadable: false, removed: false, ended: false, blocked: false, draft: false, unreachable: false }} actions={{ rename: async () => undefined, add: async () => undefined, remove: async () => undefined, resendKeys: async () => undefined, leave: async () => undefined, end: async () => undefined }} />
}
function ComposerFixture() {
  const [content, setContent] = useState(params.get('oversized') ? '😀'.repeat(501) : '')
  const [pollAttached, setPollAttached] = useState(false)
  const [preview, setPreview] = useState(false)
  return <main className="max-w-xl p-6">
    <button onClick={() => setPreview(!preview)}>Toggle preview</button>
    <ThreadPostEditor post={{ id: 'draft', content }} index={0} isActive isOnly showPreview={preview}
      onActivate={noop} onRemove={noop} onContentChange={setContent}
      extraCharacters={Number(params.get('extra') ?? 0)}
      onPollClick={() => setPollAttached(!pollAttached)} pollAttached={pollAttached} />
  </main>
}
function StatusFixture() {
  const [message, setMessage] = useState('')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [trackingCarrier, setTrackingCarrier] = useState('')
  return <StatusUpdateForm currentStatus="shipped" onStatusChange={noop}
    trackingNumber={trackingNumber} onTrackingNumberChange={setTrackingNumber}
    trackingCarrier={trackingCarrier} onTrackingCarrierChange={setTrackingCarrier}
    message={message} onMessageChange={setMessage} onSubmit={noop} onCancel={noop} isSubmitting={false} />
}
const count = Number(params.get('count') ?? 1)
const content = fixture === 'messages' ? <><NetworkPill /><MessagesPage /></>
  : fixture === 'composer' ? <ComposerFixture />
  : fixture === 'status' ? <StatusFixture />
  : fixture === 'profile-page' ? <UserPage />
  : fixture === 'export' ? <InventoryPage />
  : fixture === 'inbox' ? <InboxFixture />
  : fixture === 'group' ? <GroupFixture />
  : fixture === 'private-activity' ? <PrivateFeedDashboard />
  : fixture === 'post' ? <PostPage />
  : fixture === 'post-recovery-hook' ? <PostRecoveryFixture />
  : fixture === 'checkout' ? <CheckoutPage />
  : fixture === 'shipping' ? <ManagePage />
  : fixture === 'store' ? <StorePage />
  : fixture === 'inventory' ? <InventoryTable items={[eurItem, { ...eurItem, id: 'fallback', title: 'Store currency', currency: undefined, variants: undefined, basePrice: 600 }]} storeId="store" ownerId="owner" currency="USD" onEditItem={noop} onItemDeleted={noop} />
  : <ProfileHeader userId="owner" profile={{ displayName: 'Owner', followersCount: count, followingCount: 0 }} displayName="Owner" isDisplayNameLoading={false} profileMissing={false} username={null} allUsernames={[]} viewerId="viewer" avatarKey={0} bannerKey={0} userStore={null} hasPrivateFeed={false} isPrivateFollower={false} isFollowing={false} followLoading={false} onFollow={noop} onTip={noop} onRequireAuth={noop} onOpenUsernameModal={noop} onSelectPayment={noop} edit={{ draft: EMPTY_DRAFT, onChange: noop, isSaving: false, onStart: noop, onCancel: noop, onSave: noop, onEditAvatar: noop, onEditBanner: noop, active: false }} />
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(<>{content}<Toaster /></>)
