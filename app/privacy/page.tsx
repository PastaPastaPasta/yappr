'use client'

import { ShieldCheckIcon, EyeIcon, LockClosedIcon } from '@heroicons/react/24/outline'
import { InfoPage, InfoSection, Prose, TestnetNotice } from '@/components/layout/info-page'

const PUBLIC_DATA = [
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
]

export default function PrivacyPage() {
  return (
    <InfoPage icon={ShieldCheckIcon} title="Privacy Policy" subtitle="How your data works on a decentralized platform" updated="January 2025">
      <TestnetNotice>
        Yappr is currently running on Dash Platform&apos;s testnet. All data may be wiped at any time during network resets. Do not
        store sensitive information during the testnet phase.
      </TestnetNotice>

      <InfoSection title="Public by Design">
        <Prose>
          Yappr is built on blockchain technology, which is inherently transparent. Unlike traditional social media platforms where a
          company controls and can hide your data, blockchain data is stored on a public ledger that anyone can read. This is a
          fundamental design choice that enables decentralization but means privacy works differently than you might expect.
        </Prose>
      </InfoSection>

      <InfoSection title="What's Public" icon={EyeIcon}>
        <Prose className="mb-4">The following data is stored on the blockchain and visible to anyone:</Prose>
        <ul className="grid md:grid-cols-2 gap-3">
          {PUBLIC_DATA.map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
              <div className="h-1.5 w-1.5 bg-yappr-500 rounded-full mt-2 flex-shrink-0" />
              {item}
            </li>
          ))}
        </ul>
      </InfoSection>

      <InfoSection title="What's Encrypted" icon={LockClosedIcon} iconClassName="text-green-500">
        <Prose>
          Direct messages are encrypted before being stored on the blockchain. Only you and the recipient can read the message content.
          However, metadata such as who you&apos;re messaging and when is still visible on the blockchain.
        </Prose>
      </InfoSection>

      <InfoSection title="What's Stored on Your Device">
        <Prose className="space-y-3">
          <p>Some data is stored locally in your browser for the app to function:</p>
          <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4 space-y-3">
            <div>
              <p className="font-medium text-gray-700 dark:text-gray-300">Session Storage (cleared when you close the tab)</p>
              <p className="text-sm mt-1">
                Your private key is stored here temporarily while you&apos;re logged in. It&apos;s automatically deleted when you close the
                browser tab, providing security against persistent access.
              </p>
            </div>
            <div>
              <p className="font-medium text-gray-700 dark:text-gray-300">Local Storage (persists until cleared)</p>
              <p className="text-sm mt-1">
                Session metadata like your identity ID, balance, and profile information to restore your session on page reload. No
                private keys are stored here.
              </p>
            </div>
          </div>
        </Prose>
      </InfoSection>

      <InfoSection title="No Tracking or Analytics">
        <Prose>
          Yappr does not use any tracking cookies, analytics services, or advertising networks. We don&apos;t collect usage data, track
          your behavior, or build profiles about you. The app simply connects your browser directly to the Dash Platform network.
        </Prose>
      </InfoSection>

      <InfoSection title="Data Cannot Be Deleted">
        <Prose>
          Because data is stored on a blockchain, it cannot be deleted. There is no &quot;delete my account&quot; button because no one
          has the power to remove data from the blockchain. Once you post something, it exists permanently. This is a fundamental
          property of blockchain technology, not a choice we made.
        </Prose>
      </InfoSection>

      <InfoSection title="Third-Party Services">
        <Prose>
          To communicate with the Dash Platform blockchain, the app connects to DAPI (Decentralized API) gateway nodes. These are
          distributed nodes in the Dash network, not centralized servers we control. Your requests pass through these nodes to reach
          the blockchain. The decentralized nature of DAPI means no single party can monitor all your activity.
        </Prose>
      </InfoSection>
    </InfoPage>
  )
}
