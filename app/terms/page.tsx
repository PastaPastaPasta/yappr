'use client'

import { ArrowLeftIcon, DocumentTextIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { motion } from 'framer-motion'

export default function TermsPage() {
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
              <DocumentTextIcon className="h-8 w-8" />
              <h1 className="text-3xl font-display font-bold">Terms of Use</h1>
            </div>
            <p className="text-lg opacity-90">
              Understanding how Yappr works as a decentralized platform
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
                    Yappr is currently running on Dash Platform&apos;s testnet. This means all data, including your posts,
                    profile, and social connections, may be wiped at any time when the network resets or when we
                    migrate to mainnet. Do not rely on testnet data being permanent.
                  </p>
                </div>
              </div>
            </div>

            {/* No Central Authority */}
            <section>
              <h2 className="text-xl font-semibold mb-3">No Central Authority</h2>
              <p className="text-surface-500 dark:text-surface-400 leading-relaxed">
                Yappr is open-source software that connects directly to Dash Platform, a decentralized blockchain network.
                There is no company, organization, or central authority operating this platform. No one controls the network,
                moderates content, or has special access to user data. The software is provided as a tool for interacting
                with the Dash Platform blockchain.
              </p>
            </section>

            {/* User Responsibility */}
            <section>
              <h2 className="text-xl font-semibold mb-3">You Are Responsible</h2>
              <div className="text-surface-500 dark:text-surface-400 leading-relaxed space-y-3">
                <p>
                  When you use Yappr, you are directly interacting with a blockchain. This comes with important responsibilities:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-2">
                  <li><strong>Your private key is your identity.</strong> If you lose it, there is no way to recover your account. No one can reset your password or restore access.</li>
                  <li><strong>You own your content.</strong> Everything you post is signed with your private key and stored on the blockchain under your identity.</li>
                  <li><strong>You are responsible for your actions.</strong> Content you post reflects on you and is permanently associated with your identity.</li>
                </ul>
              </div>
            </section>

            {/* Data Permanence */}
            <section>
              <h2 className="text-xl font-semibold mb-3">Data Is Permanent</h2>
              <p className="text-surface-500 dark:text-surface-400 leading-relaxed">
                Posts, likes, follows, and other interactions are stored on the Dash Platform blockchain. Once something
                is written to the blockchain, it cannot be deleted or modified. Think carefully before you post.
                Even if content is hidden in the app interface, it remains on the blockchain and can be viewed by
                anyone with the technical knowledge to query it directly.
              </p>
            </section>

            {/* No Content Moderation */}
            <section>
              <h2 className="text-xl font-semibold mb-3">No Content Moderation</h2>
              <p className="text-surface-500 dark:text-surface-400 leading-relaxed">
                Because there is no central authority, there is no content moderation. No one can delete posts, ban users,
                or remove content from the blockchain. Users have tools to manage their own experience (such as blocking),
                but these only affect what you see, not what exists on the network. Other users and applications may still
                display content you&apos;ve blocked.
              </p>
            </section>

            {/* Transaction Costs */}
            <section>
              <h2 className="text-xl font-semibold mb-3">Transaction Costs</h2>
              <p className="text-surface-500 dark:text-surface-400 leading-relaxed">
                Creating posts, updating your profile, and other actions require Dash Platform credits. These credits
                are a form of cryptocurrency used to pay for storing data on the blockchain. You are responsible for
                maintaining sufficient credits in your identity to perform actions. On testnet, credits can be obtained
                from faucets for free.
              </p>
            </section>

            {/* No Warranty */}
            <section>
              <h2 className="text-xl font-semibold mb-3">No Warranty</h2>
              <p className="text-surface-500 dark:text-surface-400 leading-relaxed">
                This software is provided &quot;as is&quot; without warranty of any kind. The developers make no guarantees
                about availability, reliability, or fitness for any particular purpose. Use at your own risk. The
                decentralized nature of the platform means that issues cannot always be fixed or data recovered.
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
