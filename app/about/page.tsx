'use client'

import { ArrowLeftIcon, InformationCircleIcon, GlobeAltIcon, CodeBracketIcon, UserGroupIcon, ServerStackIcon, CpuChipIcon, LockClosedIcon, ShoppingBagIcon, BellIcon, CurrencyDollarIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { YAPPR_CONTRACT_ID } from '@/lib/constants'

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-surface-100 dark:bg-surface-800">
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
          className="bg-white dark:bg-surface-900 rounded-2xl shadow-lg overflow-hidden"
        >
          <div className="bg-gradient-yappr p-8 text-white">
            <div className="flex items-center gap-3 mb-4">
              <InformationCircleIcon className="h-8 w-8" />
              <h1 className="text-3xl font-bold">About Yappr</h1>
            </div>
            <p className="text-lg opacity-90">
              Decentralized social media on Dash Platform
            </p>
          </div>

          <div className="p-8 space-y-8">
            {/* What is Yappr */}
            <section>
              <h2 className="text-xl font-semibold mb-3">What is Yappr?</h2>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                Yappr is a decentralized social media platform built on Dash Platform. Unlike traditional social
                networks where a company owns and controls your data, Yappr stores everything on a blockchain.
                You truly own your identity, your content, and your social connections. No company can ban you,
                delete your posts, or shut down the service.
              </p>
            </section>

            {/* How It Works */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <GlobeAltIcon className="h-5 w-5 text-gray-500" />
                <h2 className="text-xl font-semibold">How It Works</h2>
              </div>
              <div className="text-gray-600 dark:text-gray-400 leading-relaxed space-y-3">
                <p>
                  When you use Yappr, you&apos;re interacting directly with the Dash Platform blockchain:
                </p>
                <ul className="space-y-2 list-disc list-inside">
                  <li>
                    <strong>Your identity</strong> is a cryptographic key pair. Your private key is your password,
                    your public key is your ID.
                  </li>
                  <li>
                    <strong>Your posts</strong> are documents stored on the blockchain, signed with your private key
                    to prove you created them.
                  </li>
                  <li>
                    <strong>Your username</strong> comes from DPNS (Dash Platform Name Service), mapping a
                    human-readable name to your identity.
                  </li>
                  <li>
                    <strong>Social actions</strong> like follows, likes, and reposts are all blockchain documents
                    that anyone can verify.
                  </li>
                </ul>
              </div>
            </section>

            {/* Key Features */}
            <section>
              <h2 className="text-xl font-semibold mb-4">Key Features</h2>
              <div className="grid md:grid-cols-2 gap-4">
                {[
                  { title: 'Posts', desc: 'Share your thoughts in up to 500 characters' },
                  { title: 'Profiles', desc: 'Customize your name, bio, avatar, and banner' },
                  { title: 'Follow', desc: 'Build your network and see updates from people you follow' },
                  { title: 'Likes & Reposts', desc: 'Engage with content you enjoy' },
                  { title: 'Encrypted DMs', desc: 'Private conversations, encrypted end-to-end' },
                  { title: 'Private Feeds', desc: 'Encrypted posts visible only to approved followers', href: '/about/private-feeds', icon: LockClosedIcon },
                  { title: 'Store', desc: 'Create a storefront, list items, and sell with Dash', href: '/store', icon: ShoppingBagIcon },
                  { title: 'Tips', desc: 'Send Dash tips directly to users you appreciate', icon: CurrencyDollarIcon },
                  { title: 'Notifications', desc: 'Tabbed alerts with unread indicators and preferences', icon: BellIcon },
                  { title: 'Lists', desc: 'Organize accounts into custom lists' },
                  { title: 'Bookmarks', desc: 'Save posts to revisit later' },
                  { title: 'Block & Mute', desc: 'Control what you see in your feed' },
                ].map((feature, i) => {
                  const content = (
                    <div className="bg-surface-100 dark:bg-surface-800 rounded-lg p-4">
                      <div className="flex items-center gap-2">
                        {feature.icon && <feature.icon className="h-4 w-4 text-yappr-500" />}
                        <h3 className="font-medium text-gray-900 dark:text-gray-100">{feature.title}</h3>
                      </div>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{feature.desc}</p>
                    </div>
                  )
                  return feature.href ? (
                    <Link key={i} href={feature.href} className="block hover:ring-2 hover:ring-yappr-500 rounded-lg transition-shadow">
                      {content}
                    </Link>
                  ) : (
                    <div key={i}>{content}</div>
                  )
                })}
              </div>
            </section>

            {/* No Central Server */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <ServerStackIcon className="h-5 w-5 text-gray-500" />
                <h2 className="text-xl font-semibold">No Central Server</h2>
              </div>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                Yappr has no backend servers. This website is just a client application that runs entirely in your
                browser. It connects directly to Dash Platform&apos;s decentralized network of nodes. If this website
                went offline, your data would still exist on the blockchain, and other applications could access it.
              </p>
            </section>

            {/* Open Source */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <CodeBracketIcon className="h-5 w-5 text-gray-500" />
                <h2 className="text-xl font-semibold">Open Source</h2>
              </div>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                Yappr is open source software. Anyone can view the code, verify what it does, suggest improvements,
                or create their own version. Transparency builds trust.
              </p>
              <a
                href="https://github.com/pastapastapasta/yappr"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-lg hover:opacity-90 transition-opacity text-sm font-medium"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0012 2z" />
                </svg>
                View on GitHub
              </a>
            </section>

            {/* Community */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <UserGroupIcon className="h-5 w-5 text-gray-500" />
                <h2 className="text-xl font-semibold">Community Driven</h2>
              </div>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                Yappr is a community project. There&apos;s no company behind it, no investors to please, no ads to
                sell. It exists because people believe in the idea of social media that users actually own.
                Contributions, feedback, and ideas are always welcome.
              </p>
            </section>

            {/* Technical Details */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <CpuChipIcon className="h-5 w-5 text-gray-500" />
                <h2 className="text-xl font-semibold">Technical Details</h2>
              </div>
              <div className="bg-surface-100 dark:bg-surface-800 rounded-lg p-4 space-y-3">
                <div>
                  <p className="text-sm text-gray-500">Contract ID</p>
                  <p className="text-xs font-mono text-gray-700 dark:text-gray-300 break-all">{YAPPR_CONTRACT_ID}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Network</p>
                  <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 capitalize">{process.env.NEXT_PUBLIC_NETWORK || 'testnet'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Document Types</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300">22 types across 2 contracts (social + storefront)</p>
                </div>
                <div className="pt-2">
                  <Link
                    href="/contract"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-sm font-medium"
                  >
                    <CodeBracketIcon className="h-4 w-4" />
                    View Full Data Contract
                  </Link>
                </div>
              </div>
            </section>

            {/* Resources */}
            <section>
              <h2 className="text-xl font-semibold mb-4">Resources</h2>
              <div className="grid md:grid-cols-2 gap-4">
                <a
                  href="https://dashplatform.readme.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-surface-100 dark:bg-surface-800 rounded-lg p-4 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                >
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Dash Platform Docs</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Learn about the underlying technology</p>
                </a>
                <a
                  href="https://www.dash.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-surface-100 dark:bg-surface-800 rounded-lg p-4 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                >
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Dash.org</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">The Dash cryptocurrency project</p>
                </a>
              </div>
            </section>

            {/* Last Updated */}
            <div className="pt-6 border-t border-surface-200 dark:border-neutral-750">
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
