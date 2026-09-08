'use client'

import { CircleStackIcon } from '@heroicons/react/24/outline'
import { InfoPage, InfoSection, Prose } from '@/components/layout/info-page'

function StorageCard({ tone, name, badge, summary, children }: { tone: 'green' | 'blue'; name: string; badge: string; summary: string; children: React.ReactNode }) {
  const dot = tone === 'green' ? 'bg-green-500' : 'bg-blue-500'
  const pill = tone === 'green' ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
  return (
    <div className="bg-gray-50 dark:bg-gray-950 rounded-xl p-6">
      <div className="flex items-center gap-2 mb-3">
        <div className={`h-3 w-3 ${dot} rounded-full`} />
        <h3 className="font-semibold">{name}</h3>
        <span className={`text-xs ${pill} px-2 py-0.5 rounded-full`}>{badge}</span>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{summary}</p>
      {children}
    </div>
  )
}

function StorageEntry({ tone, name, children }: { tone: 'green' | 'blue'; name: string; children: React.ReactNode }) {
  return (
    <div className={`border-l-2 ${tone === 'green' ? 'border-green-500' : 'border-blue-500'} pl-4`}>
      <p className="font-medium text-gray-700 dark:text-gray-300">{name}</p>
      <div className="text-sm text-gray-500 dark:text-gray-500 mt-1">{children}</div>
    </div>
  )
}

export default function CookiesPage() {
  return (
    <InfoPage icon={CircleStackIcon} title="Cookies & Storage" subtitle="How Yappr uses browser storage" updated="January 2025">
      <InfoSection title="No Tracking Cookies">
        <Prose>
          Yappr does not use cookies for tracking, analytics, or advertising. We don&apos;t set any third-party cookies, and we
          don&apos;t participate in any ad networks or tracking systems. Your browsing activity on Yappr is not monitored or recorded.
        </Prose>
      </InfoSection>

      <InfoSection title="What We Store Locally">
        <Prose className="mb-6">
          For the app to function, we use your browser&apos;s built-in storage mechanisms. Here&apos;s exactly what we store and why:
        </Prose>
        <div className="space-y-6">
          <StorageCard tone="green" name="Session Storage" badge="Most Secure" summary="Automatically cleared when you close the browser tab. Isolated to each tab.">
            <StorageEntry tone="green" name="Private Key">
              <p>Your private key is stored here while you&apos;re logged in. This means:</p>
              <ul className="mt-2 space-y-1 list-disc list-inside">
                <li>Closing the tab logs you out automatically</li>
                <li>Other tabs cannot access your key</li>
                <li>The key is never written to disk</li>
                <li>Refreshing the page keeps you logged in (same tab)</li>
              </ul>
            </StorageEntry>
          </StorageCard>

          <StorageCard tone="blue" name="Local Storage" badge="Persistent" summary="Persists until manually cleared. Shared across tabs on the same domain.">
            <div className="space-y-4">
              <StorageEntry tone="blue" name="Session Metadata">
                Your identity ID, cached profile data, and balance. This lets the app remember who you are when you reload the page
                (though you&apos;ll need to re-enter your key if you closed the tab).
              </StorageEntry>
              <StorageEntry tone="blue" name="App Preferences">Theme settings (dark/light mode) and other UI preferences.</StorageEntry>
            </div>
          </StorageCard>
        </div>
      </InfoSection>

      <InfoSection title="Why This Design?">
        <Prose className="space-y-3">
          <p>Security and convenience often conflict. We chose this approach because:</p>
          <ul className="space-y-2 list-disc list-inside">
            <li>
              <strong>Private keys are sensitive.</strong> They should never persist on disk where malware or other users might find
              them. Session storage provides tab-isolated, memory-only storage.
            </li>
            <li>
              <strong>Session continuity matters.</strong> We cache non-sensitive data in local storage so you don&apos;t have to fetch
              your profile every time you reload.
            </li>
            <li>
              <strong>No external dependencies.</strong> We don&apos;t rely on external cookie services or authentication providers.
              Everything happens locally in your browser.
            </li>
          </ul>
        </Prose>
      </InfoSection>

      <InfoSection title="Clearing Your Data">
        <Prose>
          You can clear all locally stored data by using your browser&apos;s &quot;Clear site data&quot; feature, or by logging out of the
          app. Clearing this data will log you out and remove all cached preferences. It will not affect your data on the blockchain.
        </Prose>
      </InfoSection>
    </InfoPage>
  )
}
