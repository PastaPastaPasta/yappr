'use client'

import Link from 'next/link'
import { CircleStackIcon } from '@heroicons/react/24/outline'
import { InfoPage, InfoSection, Prose, BulletList } from '@/components/layout/info-page'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { LEGAL_UPDATED } from '@/lib/legal'

interface StoredItem {
  name: string
  what: string
  howLong: string
}

function StorageGroup({ name, summary, items }: { name: string; summary: string; items: StoredItem[] }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-950 rounded-xl p-6">
      <h3 className="font-semibold">{name}</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-4">{summary}</p>
      <dl className="space-y-4">
        {items.map((item) => (
          <div key={item.name} className="border-l-2 border-yappr-500 pl-4">
            <dt className="font-medium text-gray-700 dark:text-gray-300">{item.name}</dt>
            <dd className="text-sm text-gray-600 dark:text-gray-400 mt-1">{item.what}</dd>
            <dd className="text-xs text-gray-500 mt-1">Kept: {item.howLong}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Wallet sign-in (App Connect builds only) keeps its keys in IndexedDB. */
const INDEXED_DB_ITEMS: StoredItem[] = [
  {
    name: 'Wallet sign-in keys',
    what: 'When you sign in with a Dash wallet app, the keys it grants Yappr are stored encrypted, under a device key the browser will not let anyone export.',
    howLong: 'until you sign out',
  },
  {
    name: 'Connection ID',
    what: 'A random ID for this browser, so your next wallet sign-in replaces this one instead of adding another.',
    howLong: 'until you clear site data',
  },
]

export default function CookiesPage() {
  // Builds with wallet sign-in keep the most powerful typed-in keys for the tab only, and wallet keys in IndexedDB.
  const walletBuild = isAppConnectBuild()

  const localItems: StoredItem[] = [
    {
      name: 'Your sign-in key',
      what: walletBuild
        ? 'When you sign in with a private key, Yappr keeps it so you stay signed in. Your identity’s most powerful (CRITICAL) key is the exception (see below).'
        : 'When you sign in with a private key, Yappr keeps it so you stay signed in.',
      howLong: 'until you sign out',
    },
    {
      name: 'Encryption keys',
      what: 'Your encryption key, which opens your messages and private feed, and the keys for the private feeds you follow.',
      howLong: 'until you sign out',
    },
    {
      name: 'Session details',
      what: 'Your identity ID, username, profile and balance, so the app can show them straight away.',
      howLong: 'until you sign out',
    },
    {
      name: 'Settings, drafts and caches',
      what: 'Theme and other preferences, unsent drafts, your cart, and copies of recently loaded posts and profiles, so pages load faster.',
      howLong: 'until you clear site data',
    },
    {
      name: 'Upload service details',
      what: 'If you connect Storacha or Pinata to upload media, the details needed to use your account.',
      howLong: 'until you disconnect the service',
    },
  ]

  const sessionItems: StoredItem[] = [
    ...(walletBuild
      ? [{
          name: 'Your most powerful key',
          what: 'If the key you enter is your identity’s most powerful (CRITICAL) key, Yappr keeps it only until you close this tab.',
          howLong: 'until you close the tab',
        }]
      : []),
    { name: 'Tab state', what: 'Small markers for this tab, such as a sign-in step in progress.', howLong: 'until you close the tab' },
  ]

  return (
    <InfoPage icon={CircleStackIcon} title="Cookies & Storage" subtitle="What Yappr keeps in your browser, and why" updated={LEGAL_UPDATED}>
      <InfoSection title="Cookies">
        <Prose className="space-y-3">
          <p>
            Yappr itself sets no cookies, and there are no advertising or tracking cookies. Cloudflare, which delivers the site, may
            set a short-lived security cookie to protect it from abuse.
          </p>
          <p>
            We count visits with Cloudflare Web Analytics, which uses no cookies and builds no profile of you. The{' '}
            <Link href="/privacy" className="underline">Privacy Policy</Link> lists every service your browser talks to.
          </p>
        </Prose>
      </InfoSection>

      <InfoSection title="What Yappr stores in your browser">
        <Prose className="mb-6">
          Yappr has no server to remember you, so it keeps what it needs in your browser&apos;s own storage. None of it is sent to
          us.
        </Prose>
        <div className="space-y-6">
          <StorageGroup name="Local storage" summary="Stays on this device, shared by all Yappr tabs, until removed." items={localItems} />
          {walletBuild && <StorageGroup name="IndexedDB" summary="Stays on this device until removed." items={INDEXED_DB_ITEMS} />}
          <StorageGroup name="Session storage" summary="Belongs to one tab and is cleared when that tab closes." items={sessionItems} />
        </div>
      </InfoSection>

      <InfoSection title="Keeping your keys safe">
        <Prose>
          <BulletList>
            <li>
              Staying signed in means your key is stored on this device. Anyone who can use this browser profile could use it, so sign
              out on computers you share.
            </li>
            <li>Malicious browser extensions or software on your device could read stored keys. Only install ones you trust.</li>
            {walletBuild && (
              <li>
                Signing in with a Dash wallet app, where your wallet supports it, gives Yappr limited keys of its own, so your
                identity&apos;s main keys never enter the browser.
              </li>
            )}
          </BulletList>
        </Prose>
      </InfoSection>

      <InfoSection title="Clearing your data">
        <Prose>
          Signing out removes your keys and session from this browser. To remove everything else, use your browser&apos;s
          &quot;Clear site data&quot; for this site. Neither affects anything on Dash Platform.
        </Prose>
      </InfoSection>
    </InfoPage>
  )
}
