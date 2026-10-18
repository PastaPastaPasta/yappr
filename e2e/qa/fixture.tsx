import { TrendingHashtagRow } from '@/components/explore/trending-hashtag-row'
import { RankingWindowToggle } from '@/components/explore/ranking-window-toggle'
import { ContractModerationSettings } from '@/components/settings/contract-moderation-settings'
import { exposePayoutHistory } from './mocks'
import { BlogSettings } from '@/components/blog/blog-settings'
import { PollEditor, createPollDraft } from '@/components/compose/poll-editor'
import { ConnectionRow } from '@/components/profile/connection-list-page'
import { BlogComments } from '@/components/blog/blog-comments'
import { IconButton } from '@/components/ui/icon-button'
import { SessionFixture } from './session-fixture'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ThemeProvider, useTheme } from 'next-themes'
import { CreateBlogModal } from '@/components/blog/create-blog-modal'
import { BlogViewer } from '@/components/blog/blog-viewer'
import { BlogDiscovery } from '@/components/blog/blog-discovery'
import { useDeletedBlogs } from '@/lib/blog/deleted-blogs'
import { ElectionStatusPanel } from '@/components/moderation/election-status-panel'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import { SettingsSwitch } from '@/components/settings/settings-switch'
import { PasskeySettings } from '@/components/settings/passkey-settings'
import { WalletUsernameGuide } from '@/components/dpns/wallet-username-guide'
import { KeyLoginForm } from '@/components/auth/key-login-form'
import '@/app/globals.css'

const scenario = new URLSearchParams(location.search).get('scenario')
const router = { back() {}, forward() {}, refresh() {}, push(href: string) { location.assign(href) }, replace(href: string) { location.replace(href) }, prefetch: async () => undefined }
function ReaderFixture() {
  const { resolvedTheme, setTheme } = useTheme()
  return <><button onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>Toggle reader theme</button><BlogViewer blocks={[{ type: 'paragraph', content: [{ type: 'text', text: 'Published prose remains a document.', styles: {} }] }]} /></>
}
function Fixture() {
  const [revision, setRevision] = useState(0)
  const [open, setOpen] = useState(false)
  return <AppRouterContext.Provider value={router}><ThemeProvider attribute="class" defaultTheme="light"><main className="bg-white text-gray-900 dark:bg-neutral-900 dark:text-white min-h-screen p-5">
    <h1>Release regression fixture</h1>
    {scenario === 'tokens' ? <><IconButton variant="primary" aria-label="Primary action">Go</IconButton><button className="text-gray-400 hover:text-gray-500">Muted action</button></> : scenario === 'connection' ? <ConnectionRow user={{ id: 'offline-person', username: 'alice', displayName: 'Alice', hasProfile: false, hasDpnsName: true, followersCount: 0, followingCount: 0, isFollowing: false, allUsernames: ['alice'] }} showActions={false} followLabel="Follow" busy={false} onToggleFollow={() => undefined} /> : scenario === 'comments' ? <BlogComments blogPostId="offline-post" blogPostOwnerId="author" commentsEnabled /> : scenario === 'pot' ? <><button onClick={exposePayoutHistory}>Replica catches up</button><ContractModerationSettings contract="storefront" /></> : scenario === 'copy' ? <><BlogSettings blog={{ id: 'blog', ownerId: 'author', name: 'Fixture blog', createdAt: new Date() }} ownerId="author" onDeleted={() => undefined} /><PollEditor draft={createPollDraft()} question="Tea or coffee?" onChange={() => undefined} onRemove={() => undefined} /></> : scenario === 'trends' ? <><RankingWindowToggle axis="hashtags" testIdPrefix="trends" value="all" onChange={() => undefined} /><TrendingHashtagRow trend={{ hashtag: 'yappr', postCount: 12 }} index={0} /><TrendingHashtagRow trend={{ hashtag: 'dash_cashtag', postCount: 1 }} index={1} /></> : scenario === 'session' ? <SessionFixture /> : scenario === 'discovery' ? <><button onClick={() => useDeletedBlogs.getState().mark('delete-me')}>Confirm deletion</button><button onClick={() => setRevision((value) => value + 1)}>Remount discovery</button><BlogDiscovery key={revision} /></>
      : scenario?.startsWith('election-') ? <ElectionStatusPanel contract={scenario.slice(9) as ModeratedContractKey} />
      : scenario === 'create' ? <><button onClick={() => setOpen(true)}>New blog</button><CreateBlogModal open={open} onOpenChange={setOpen} /></>
      : scenario === 'reader' ? <ReaderFixture />
      : scenario === 'passkeys' ? <PasskeySettings />
      : scenario === 'wallet' ? <WalletUsernameGuide additional onComplete={() => undefined} onSkip={() => undefined} />
      : scenario === 'key' ? <KeyLoginForm onComplete={() => undefined} />
      : <div className="flex gap-4 max-w-[250px]"><span>Show query inspector while browsing and reading posts</span><SettingsSwitch checked aria-label="Show query inspector" /></div>}
  </main></ThemeProvider></AppRouterContext.Provider>
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(<Fixture />)
