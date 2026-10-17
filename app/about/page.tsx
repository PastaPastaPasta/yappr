'use client'

import type { ComponentType } from 'react'
import Link from 'next/link'
import { contentLimits } from '@/lib/contract-topology'
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
  BookOpenIcon,
  FlagIcon,
  ScaleIcon,
  ChatBubbleLeftRightIcon,
} from '@heroicons/react/24/outline'
import { YAPPR_CONTRACT_ID, getContractTopology } from '@/lib/constants'
import { InfoPage, InfoSection, Prose } from '@/components/layout/info-page'
import { COMMUNITY_RULES_HREF, ISSUES_URL, LEGAL_UPDATED, SOURCE_URL, SUPPORT_EMAIL, SUPPORT_MAILTO } from '@/lib/legal'

const GITHUB_PATH =
  'M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0012 2z'

interface Feature {
  title: string
  desc: string
  href?: string
  icon?: ComponentType<{ className?: string }>
}

const FEATURES: Feature[] = [
  { title: 'Posts', desc: `Share your thoughts in up to ${contentLimits().maxLength} characters` },
  { title: 'Profiles', desc: 'Customize your name, bio, avatar, and banner' },
  { title: 'Follow', desc: 'Build your network and see updates from people you follow' },
  { title: 'Likes & Reposts', desc: 'Engage with content you enjoy' },
  { title: 'Polls', desc: 'Ask a question and let people vote' },
  { title: 'Encrypted Messages', desc: 'One-to-one and group conversations, encrypted end-to-end' },
  { title: 'Private Feeds', desc: 'Encrypted posts for the followers you approve', href: '/about/private-feeds', icon: LockClosedIcon },
  { title: 'Store', desc: 'Create a storefront, list items, and get paid directly', href: '/store', icon: ShoppingBagIcon },
  { title: 'Blog', desc: 'Write long-form posts with your own blog', href: '/blog', icon: BookOpenIcon },
  { title: 'Tips', desc: 'Tip people straight to the payment addresses they list', icon: CurrencyDollarIcon },
  { title: 'Notifications', desc: 'Tabbed alerts with unread indicators and preferences', icon: BellIcon },
  { title: 'Bookmarks', desc: 'Save posts to revisit later (bookmarks are public)' },
  { title: 'Blocking & Reporting', desc: 'Control what you see, and report what breaks the rules', icon: FlagIcon },
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
    <InfoPage icon={InformationCircleIcon} title="About Yappr" subtitle="Decentralized social media on Dash Platform" updated={LEGAL_UPDATED}>
      <InfoSection title="What is Yappr?">
        <Prose>
          Yappr is a social app for Dash Platform. Instead of a company database, your identity, posts and connections live on a
          public network, signed with keys only you hold. Any app can read them, so you can take them with you, and the rules are
          enforced in the open by elected community moderators rather than by a company behind closed doors.
        </Prose>
      </InfoSection>

      <InfoSection title="How It Works" icon={GlobeAltIcon}>
        <Prose className="space-y-3">
          <p>When you use Yappr, you&apos;re interacting directly with Dash Platform:</p>
          <ul className="space-y-2 list-disc list-inside">
            <li>
              <strong>Your identity</strong> is an account on Dash Platform with its own ID and keys. Your private keys prove it&apos;s
              you, so keep them safe: nobody can recover them for you.
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
          Yappr has no backend servers. This website is a client application that runs entirely in your browser and connects
          directly to Dash Platform&apos;s network of nodes. If this website went offline, your data would still exist on Dash
          Platform, and other applications could read it. The <Link href="/privacy" className="underline">Privacy Policy</Link> lists
          the few outside services the app does use, such as hosting and image loading.
        </Prose>
      </InfoSection>

      <InfoSection title="Moderated in the Open" icon={ScaleIcon}>
        <Prose className="space-y-3">
          <p>
            Yappr&apos;s social network, blogs and stores each have a moderation team elected on Dash Platform. Moderators can remove
            content and warn, suspend or ban accounts, but only for a reason listed in their team&apos;s published charter, and every
            action leaves a public record.
          </p>
          <p>
            Anyone can report a post, reply or profile, and you can block anyone. Read the{' '}
            <Link href={COMMUNITY_RULES_HREF} className="underline">Community Rules</Link>.
          </p>
        </Prose>
      </InfoSection>

      <InfoSection title="Open Source" icon={CodeBracketIcon}>
        <Prose className="mb-4">
          Yappr is open source software. Anyone can view the code, verify what it does, suggest improvements, or create their own
          version. Transparency builds trust.
        </Prose>
        <a
          href={SOURCE_URL}
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
          Yappr is an open-source community project with no ads. It exists because people believe in social media that users
          actually own. Contributions, feedback, and ideas are always welcome.
        </Prose>
      </InfoSection>

      <InfoSection title="Contact" icon={ChatBubbleLeftRightIcon}>
        <Prose className="space-y-2">
          <p>
            Questions, abuse reports, or legal requests: <a href={SUPPORT_MAILTO} className="underline">{SUPPORT_EMAIL}</a>.
          </p>
          <p>
            Found a bug or have an idea?{' '}
            <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer" className="underline">Open an issue on GitHub</a>.
          </p>
          <p>
            <Link href="/terms" className="underline">Terms</Link> · <Link href="/privacy" className="underline">Privacy</Link> ·{' '}
            <Link href="/cookies" className="underline">Cookies</Link>
          </p>
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
              client pointed at the v9 contract queries fields that do not exist.
              Printing the compiled-in topology makes that verifiable from the
              served artifact; the e2e suite gates on it. */}
          <Detail label="Interaction Topology">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300" data-testid="about-topology">
              {getContractTopology()}
            </p>
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
