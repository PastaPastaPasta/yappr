import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { Toaster } from 'react-hot-toast'
import { UsernameModal } from '../../components/dpns/username-modal'
import { BlogPostView } from '@/components/blog/blog-post-view'
import { InventoryTable } from '@/components/store/inventory-table'
import { useReaderPreferencesStore } from '@/lib/store'
import ItemPage from '@/app/item/page'
import { eurItem } from './qa-round1-mocks'
import { BlogSettings } from '@/components/blog/blog-settings'
import { BlogThemeProvider } from '@/components/blog/theme-provider'
import { BlogViewer } from '@/components/blog/blog-viewer'
import { NewGroupDialog } from '@/components/messages/new-group-dialog'
import { StarRatingInput } from '@/components/store/star-rating-input'
import ManagePage from '@/app/store/manage/page'
import BookmarksPage from '@/app/bookmarks/page'
import PrivateGuide from '@/app/about/private-feeds/page'
import { usePostDetail } from '../../hooks/use-post-detail'
import { publishReply, threadReads } from './tqa-mocks'
import { getDefaultBlogThemeConfig } from '@/lib/blog/theme-types'
import { getReaderOverrideStyle } from '@/lib/blog/reader-preferences'
import '@/app/globals.css'
const params = new URLSearchParams(window.location.search)
const noop = () => undefined
function UsernameFixture() {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>Register usernames</button><a href="#background">Background link</a><UsernameModal isOpen={open} onClose={() => setOpen(false)} hasExistingUsernames /></>
}
function Stars() {
  const [rating, setRating] = useState(0)
  return <><StarRatingInput value={rating} onChange={setRating} /><button disabled={!rating}>Submit review</button></>
}
function Thread() {
  const { replyThreads, error, refresh, isLoadingReplies } = usePostDetail({ postId: 'root' })
  return <><button onClick={publishReply}>Publish accepted reply</button><button onClick={() => refresh()}>Refresh</button>{error && <div role="alert">{error}</div>}<p>{isLoadingReplies ? 'Refreshing' : 'Settled'}</p><div>{replyThreads.map(thread => <article key={thread.content.id}>{thread.content.content}{thread.nestedReplies.map(child => <p key={child.content.id}>{child.content.content}</p>)}</article>)}</div><output aria-label="Thread reads">{threadReads()}</output></>
}
const theme = getDefaultBlogThemeConfig()
document.documentElement.classList.toggle('dark', params.get('mode') === 'dark')
const fixture = params.get('fixture')
useReaderPreferencesStore.setState({ readingMode: params.get('mode') === 'dark' ? 'dark' : params.get('mode') === 'sepia' ? 'sepia' : 'light' })
const content = fixture === 'username' ? <UsernameFixture />
  : fixture === 'blog-settings' ? <BlogSettings blog={{ id: 'blog', ownerId: 'owner', name: 'QA blog', createdAt: new Date(0) }} ownerId="owner" onDeleted={noop} />
  : fixture === 'new-group' ? <NewGroupDialog open onOpenChange={noop} viewerId="owner" onCreate={async () => undefined} />
  : fixture === 'stars' ? <Stars />
  : fixture === 'manage' ? <ManagePage />
  : fixture === 'inventory' ? <InventoryTable items={[eurItem]} storeId="store" ownerId="owner" currency="USD" onEditItem={noop} onItemDeleted={noop} />
  : fixture === 'item' ? <ItemPage />
  : fixture === 'article' ? <BlogPostView blog={{ id: 'blog', ownerId: 'owner', name: 'QA blog', createdAt: new Date(0), themeConfig: theme }} post={{ id: 'article', blogId: 'blog', ownerId: 'owner', title: 'Readable article', slug: 'readable', createdAt: new Date(1700000000000), publishedAt: 1700000000000, content: [{ type: 'quote', content: 'A readable quotation.' }], commentsEnabled: false }} username="author" />
  : fixture === 'bookmarks' ? <BookmarksPage />
  : fixture === 'thread' ? <Thread />
  : fixture === 'guide' ? <PrivateGuide />
  : <BlogThemeProvider blogName="QA blog" hideHeader themeConfig={theme} readerOverrides={getReaderOverrideStyle(params.get('mode') === 'dark' ? 'dark' : params.get('mode') === 'sepia' ? 'sepia' : 'light')}><p style={{ color: 'var(--blog-muted)' }}>Published yesterday · 4 min read</p><BlogViewer blocks={[{ type: 'quote', content: 'A readable quotation.' }]} /></BlogThemeProvider>
const root = document.getElementById('root')
if (!root) throw new Error('Missing root')
createRoot(root).render(<main>{content}<Toaster /></main>)
