'use client'

import type { ComponentType } from 'react'
import Link from 'next/link'
import {
  InformationCircleIcon,
  GlobeAltIcon,
  CodeBracketIcon,
  UserGroupIcon,
  ServerStackIcon,
  CpuChipIcon,
  LockClosedIcon,
  ShoppingBagIcon,
  BellIcon,
  CurrencyDollarIcon,
} from '@heroicons/react/24/outline'
import { YAPPR_CONTRACT_ID, getContractTopology } from '@/lib/constants'
import { InfoPage, InfoSection, Prose } from '@/components/layout/info-page'

const GITHUB_PATH =
  'M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0012 2z'

interface Feature {
  title: string
  desc: string
  href?: string
  icon?: ComponentType<{ className?: string }>
}

const FEATURES: Feature[] = [
  { title: 'Posts', desc: 'Share your thoughts in up to 500 characters' },
  { title: 'Profiles', desc: 'Customize your name, bio, avatar, and banner' },
  { title: 'Follow', desc: 'Build your network and see updates from people you follow' },
  { title: 'Likes & Reposts', desc: 'Engage with content you enjoy' },
  { title: 'Encrypted DMs', desc: 'Private conversations, encrypted end-to-end' },
  { title: 'Private Feeds', desc: 'Encrypted posts visible only to approved followers', href: '/about/private-feeds', icon: LockClosedIcon },
  { title: 'Store', desc: 'Create a storefront, list items, and sell with Dash', href: '/store', icon: ShoppingBagIcon },
  { title: 'Tips', desc: 'Send Dash tips directly to users you appreciate', icon: CurrencyDollarIcon },
  { title: 'Notifications', desc: 'Tabbed alerts with unread indicators and preferences', icon: BellIcon },
  { title: 'Bookmarks', desc: 'Save posts to revisit later' },
  { title: 'Blocking', desc: 'Control what you see in your feed' },
]

const RESOURCES = [
  { href: 'https://dashplatform.readme.io', title: 'Dash Platform Docs', desc: 'Learn about the underlying technology' },
  { href: 'https://www.dash.org', title: 'Dash.org', desc: 'The Dash cryptocurrency project' },
]

function FeatureCard({ feature }: { feature: Feature }) {
  const card = (
    <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
      <div className="flex items-center gap-2">
        {feature.icon && <feature.icon className="h-4 w-4 text-yappr-500" />}
        <h3 className="font-medium text-gray-900 dark:text-gray-100">{feature.title}</h3>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{feature.desc}</p>
    </div>
  )
  return feature.href ? (
    <Link href={feature.href} className="block hover:ring-2 hover:ring-yappr-500 rounded-lg transition-shadow">
      {card}
    </Link>
  ) : (
    <div>{card}</div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm text-gray-500">{label}</p>
      {children}
    </div>
  )
}

export default function AboutPage() {
  return (
    <InfoPage icon={InformationCircleIcon} title="About Yappr" subtitle="Decentralized social media on Dash Platform" updated="January 2025">
      <InfoSection title="What is Yappr?">
        <Prose>
          Yappr is a decentralized social media platform built on Dash Platform. Unlike traditional social networks where a company
          owns and controls your data, Yappr stores everything on a blockchain. You truly own your identity, your content, and your
          social connections. No company can ban you, delete your posts, or shut down the service.
        </Prose>
      </InfoSection>

      <InfoSection title="How It Works" icon={GlobeAltIcon}>
        <Prose className="space-y-3">
          <p>When you use Yappr, you&apos;re interacting directly with the Dash Platform blockchain:</p>
          <ul className="space-y-2 list-disc list-inside">
            <li>
              <strong>Your identity</strong> is a cryptographic key pair. Your private key is your password, your public key is your ID.
            </li>
            <li>
              <strong>Your posts</strong> are documents stored on the blockchain, signed with your private key to prove you created them.
            </li>
            <li>
              <strong>Your username</strong> comes from DPNS (Dash Platform Name Service), mapping a human-readable name to your identity.
            </li>
            <li>
              <strong>Social actions</strong> like follows, likes, and reposts are all blockchain documents that anyone can verify.
            </li>
          </ul>
        </Prose>
      </InfoSection>

      <section>
        <h2 className="text-xl font-semibold mb-4">Key Features</h2>
        <div className="grid md:grid-cols-2 gap-4">
          {FEATURES.map((feature) => (
            <FeatureCard key={feature.title} feature={feature} />
          ))}
        </div>
      </section>

      <InfoSection title="No Central Server" icon={ServerStackIcon}>
        <Prose>
          Yappr has no backend servers. This website is just a client application that runs entirely in your browser. It connects
          directly to Dash Platform&apos;s decentralized network of nodes. If this website went offline, your data would still exist on
          the blockchain, and other applications could access it.
        </Prose>
      </InfoSection>

      <InfoSection title="Open Source" icon={CodeBracketIcon}>
        <Prose className="mb-4">
          Yappr is open source software. Anyone can view the code, verify what it does, suggest improvements, or create their own
          version. Transparency builds trust.
        </Prose>
        <a
          href="https://github.com/pastapastapasta/yappr"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-lg hover:opacity-90 transition-opacity text-sm font-medium"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path fillRule="evenodd" clipRule="evenodd" d={GITHUB_PATH} />
          </svg>
          View on GitHub
        </a>
      </InfoSection>

      <InfoSection title="Community Driven" icon={UserGroupIcon}>
        <Prose>
          Yappr is a community project. There&apos;s no company behind it, no investors to please, no ads to sell. It exists because
          people believe in the idea of social media that users actually own. Contributions, feedback, and ideas are always welcome.
        </Prose>
      </InfoSection>

      <InfoSection title="Technical Details" icon={CpuChipIcon}>
        <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4 space-y-3">
          <Detail label="Contract ID">
            <p className="text-xs font-mono text-gray-700 dark:text-gray-300 break-all">{YAPPR_CONTRACT_ID}</p>
          </Detail>
          <Detail label="Network">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 capitalize">{process.env.NEXT_PUBLIC_NETWORK || 'testnet'}</p>
          </Detail>
          {/* The contract id does not say which SHAPE of contract it is, and a v2
              client pointed at a v3 contract queries fields that do not exist.
              Printing the compiled-in topology makes that verifiable from the
              served artifact; the e2e suite gates on it. */}
          <Detail label="Interaction Topology">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300" data-testid="about-topology">
              {getContractTopology()}
            </p>
          </Detail>
          <Detail label="Document Types">
            <p className="text-sm text-gray-700 dark:text-gray-300">23 types across 2 contracts (social + storefront)</p>
          </Detail>
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
      </InfoSection>

      <section>
        <h2 className="text-xl font-semibold mb-4">Resources</h2>
        <div className="grid md:grid-cols-2 gap-4">
          {RESOURCES.map((r) => (
            <a
              key={r.href}
              href={r.href}
              target="_blank"
              rel="noopener noreferrer"
              className="block bg-gray-50 dark:bg-gray-950 rounded-lg p-4 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            >
              <h3 className="font-medium text-gray-900 dark:text-gray-100">{r.title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{r.desc}</p>
            </a>
          ))}
        </div>
      </section>
    </InfoPage>
  )
}
