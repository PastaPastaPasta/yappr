'use client'

import { ArrowLeftIcon, CircleStackIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { motion } from 'framer-motion'

export default function CookiesPage() {
  return (
    <div className="min-h-screen bg-surface-50 dark:bg-surface-950">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-surface-500 dark:text-surface-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back to Yappr
          </Link>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white dark:bg-surface-900 rounded-2xl shadow-lg overflow-hidden"
        >
          <div className="bg-gradient-yappr p-8 text-white">
            <div className="flex items-center gap-3 mb-4">
              <CircleStackIcon className="h-8 w-8" />
              <h1 className="text-3xl font-display font-bold">Cookies & Storage</h1>
            </div>
            <p className="text-lg opacity-90">
              How Yappr uses browser storage
            </p>
          </div>

          <div className="p-8 space-y-8">
            {/* No Tracking */}
            <section>
              <h2 className="text-xl font-semibold mb-3">No Tracking Cookies</h2>
              <p className="text-surface-500 dark:text-surface-400 leading-relaxed">
                Yappr does not use cookies for tracking, analytics, or advertising. We don&apos;t set any third-party
                cookies, and we don&apos;t participate in any ad networks or tracking systems. Your browsing activity
                on Yappr is not monitored or recorded.
              </p>
            </section>

            {/* What We Store */}
            <section>
              <h2 className="text-xl font-semibold mb-3">What We Store Locally</h2>
              <p className="text-surface-500 dark:text-surface-400 leading-relaxed mb-6">
                For the app to function, we use your browser&apos;s built-in storage mechanisms. Here&apos;s exactly
                what we store and why:
              </p>

              <div className="space-y-6">
                {/* Session Storage */}
                <div className="bg-surface-50 dark:bg-surface-950 rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-3 w-3 bg-green-500 rounded-full" />
                    <h3 className="font-semibold">Session Storage</h3>
                    <span className="text-xs bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full">
                      Most Secure
                    </span>
                  </div>
                  <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                    Automatically cleared when you close the browser tab. Isolated to each tab.
                  </p>
                  <div className="border-l-2 border-green-500 pl-4">
                    <p className="font-medium text-gray-700 dark:text-gray-300">Private Key</p>
                    <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
                      Your private key is stored here while you&apos;re logged in. This means:
                    </p>
                    <ul className="text-sm text-gray-500 dark:text-gray-500 mt-2 space-y-1 list-disc list-inside">
                      <li>Closing the tab logs you out automatically</li>
                      <li>Other tabs cannot access your key</li>
                      <li>The key is never written to disk</li>
                      <li>Refreshing the page keeps you logged in (same tab)</li>
                    </ul>
                  </div>
                </div>

                {/* Local Storage */}
                <div className="bg-surface-50 dark:bg-surface-950 rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-3 w-3 bg-blue-500 rounded-full" />
                    <h3 className="font-semibold">Local Storage</h3>
                    <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">
                      Persistent
                    </span>
                  </div>
                  <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                    Persists until manually cleared. Shared across tabs on the same domain.
                  </p>
                  <div className="space-y-4">
                    <div className="border-l-2 border-blue-500 pl-4">
                      <p className="font-medium text-gray-700 dark:text-gray-300">Session Metadata</p>
                      <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
                        Your identity ID, cached profile data, and balance. This lets the app remember who
                        you are when you reload the page (though you&apos;ll need to re-enter your key if you
                        closed the tab).
                      </p>
                    </div>
                    <div className="border-l-2 border-blue-500 pl-4">
                      <p className="font-medium text-gray-700 dark:text-gray-300">App Preferences</p>
                      <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
                        Theme settings (dark/light mode) and other UI preferences.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Why This Design */}
            <section>
              <h2 className="text-xl font-semibold mb-3">Why This Design?</h2>
              <div className="text-surface-500 dark:text-surface-400 leading-relaxed space-y-3">
                <p>
                  Security and convenience often conflict. We chose this approach because:
                </p>
                <ul className="space-y-2 list-disc list-inside">
                  <li>
                    <strong>Private keys are sensitive.</strong> They should never persist on disk where malware
                    or other users might find them. Session storage provides tab-isolated, memory-only storage.
                  </li>
                  <li>
                    <strong>Session continuity matters.</strong> We cache non-sensitive data in local storage so
                    you don&apos;t have to fetch your profile every time you reload.
                  </li>
                  <li>
                    <strong>No external dependencies.</strong> We don&apos;t rely on external cookie services or
                    authentication providers. Everything happens locally in your browser.
                  </li>
                </ul>
              </div>
            </section>

            {/* Clearing Storage */}
            <section>
              <h2 className="text-xl font-semibold mb-3">Clearing Your Data</h2>
              <p className="text-surface-500 dark:text-surface-400 leading-relaxed">
                You can clear all locally stored data by using your browser&apos;s &quot;Clear site data&quot; feature,
                or by logging out of the app. Clearing this data will log you out and remove all cached
                preferences. It will not affect your data on the blockchain.
              </p>
            </section>

            {/* Last Updated */}
            <div className="pt-6 border-t border-surface-200 dark:border-surface-800">
              <p className="text-sm text-gray-500">
                Last updated: January 2025
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
