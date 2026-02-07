'use client'

import { ArrowLeftIcon, ShieldCheckIcon, ExclamationTriangleIcon, EyeIcon, LockClosedIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { motion } from 'framer-motion'

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back to Yappr
          </Link>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg overflow-hidden"
        >
          <div className="bg-gradient-yappr p-8 text-white">
            <div className="flex items-center gap-3 mb-4">
              <ShieldCheckIcon className="h-8 w-8" />
              <h1 className="text-3xl font-bold">Privacy Policy</h1>
            </div>
            <p className="text-lg opacity-90">
              How your data works on a decentralized platform
            </p>
          </div>

          <div className="p-8 space-y-8">
            {/* Testnet Warning */}
            <div className="bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded-xl p-6">
              <div className="flex items-start gap-4">
                <ExclamationTriangleIcon className="h-6 w-6 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <h2 className="font-semibold text-amber-800 dark:text-amber-200 mb-2">Testnet Notice</h2>
                  <p className="text-amber-700 dark:text-amber-300 text-sm">
                    Yappr is currently running on Dash Platform&apos;s testnet. All data may be wiped at any time
                    during network resets. Do not store sensitive information during the testnet phase.
                  </p>
                </div>
              </div>
            </div>

            {/* Public by Design */}
            <section>
              <h2 className="text-xl font-semibold mb-3">Public by Design</h2>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                Yappr is built on blockchain technology, which is inherently transparent. Unlike traditional social
                media platforms where a company controls and can hide your data, blockchain data is stored on a
                public ledger that anyone can read. This is a fundamental design choice that enables decentralization
                but means privacy works differently than you might expect.
              </p>
            </section>

            {/* What's Public */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <EyeIcon className="h-5 w-5 text-gray-500" />
                <h2 className="text-xl font-semibold">What&apos;s Public</h2>
              </div>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                The following data is stored on the blockchain and visible to anyone:
              </p>
              <ul className="grid md:grid-cols-2 gap-3">
                {[
                  'Your profile (display name, bio, website, location)',
                  'Your avatar and banner images',
                  'All posts you create',
                  'Who you follow and who follows you',
                  'Likes and reposts',
                  'Bookmarks',
                  'Your DPNS username',
                  'Your identity ID (public key)',
                  'Timestamps of all actions',
                  'Transaction history',
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
                    <div className="h-1.5 w-1.5 bg-yappr-500 rounded-full mt-2 flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            {/* What's Encrypted */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <LockClosedIcon className="h-5 w-5 text-green-500" />
                <h2 className="text-xl font-semibold">What&apos;s Encrypted</h2>
              </div>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                Direct messages are encrypted before being stored on the blockchain. Only you and the recipient
                can read the message content. However, metadata such as who you&apos;re messaging and when is still
                visible on the blockchain.
              </p>
            </section>

            {/* Local Storage */}
            <section>
              <h2 className="text-xl font-semibold mb-3">What&apos;s Stored on Your Device</h2>
              <div className="text-gray-600 dark:text-gray-400 leading-relaxed space-y-3">
                <p>
                  Some data is stored locally in your browser for the app to function:
                </p>
                <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4 space-y-3">
                  <div>
                    <p className="font-medium text-gray-700 dark:text-gray-300">Session Storage (cleared when you close the tab)</p>
                    <p className="text-sm mt-1">Your private key is stored here temporarily while you&apos;re logged in. It&apos;s automatically deleted when you close the browser tab, providing security against persistent access.</p>
                  </div>
                  <div>
                    <p className="font-medium text-gray-700 dark:text-gray-300">Local Storage (persists until cleared)</p>
                    <p className="text-sm mt-1">Session metadata like your identity ID, balance, and profile information to restore your session on page reload. No private keys are stored here.</p>
                  </div>
                </div>
              </div>
            </section>

            {/* No Tracking */}
            <section>
              <h2 className="text-xl font-semibold mb-3">No Tracking or Analytics</h2>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                Yappr does not use any tracking cookies, analytics services, or advertising networks. We don&apos;t
                collect usage data, track your behavior, or build profiles about you. The app simply connects
                your browser directly to the Dash Platform network.
              </p>
            </section>

            {/* No Deletion */}
            <section>
              <h2 className="text-xl font-semibold mb-3">Data Cannot Be Deleted</h2>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                Because data is stored on a blockchain, it cannot be deleted. There is no &quot;delete my account&quot;
                button because no one has the power to remove data from the blockchain. Once you post something,
                it exists permanently. This is a fundamental property of blockchain technology, not a choice we made.
              </p>
            </section>

            {/* Third Parties */}
            <section>
              <h2 className="text-xl font-semibold mb-3">Third-Party Services</h2>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                To communicate with the Dash Platform blockchain, the app connects to DAPI (Decentralized API)
                gateway nodes. These are distributed nodes in the Dash network, not centralized servers we control.
                Your requests pass through these nodes to reach the blockchain. The decentralized nature of DAPI
                means no single party can monitor all your activity.
              </p>
            </section>

            {/* Last Updated */}
            <div className="pt-6 border-t border-gray-200 dark:border-gray-800">
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
