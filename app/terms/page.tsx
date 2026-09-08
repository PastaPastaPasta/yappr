'use client'

import { DocumentTextIcon } from '@heroicons/react/24/outline'
import { InfoPage, InfoSection, Prose, TestnetNotice } from '@/components/layout/info-page'

export default function TermsPage() {
  return (
    <InfoPage icon={DocumentTextIcon} title="Terms of Use" subtitle="Understanding how Yappr works as a decentralized platform" updated="January 2025">
      <TestnetNotice>
        Yappr is currently running on Dash Platform&apos;s testnet. This means all data, including your posts, profile, and social
        connections, may be wiped at any time when the network resets or when we migrate to mainnet. Do not rely on testnet data
        being permanent.
      </TestnetNotice>

      <InfoSection title="No Central Authority">
        <Prose>
          Yappr is open-source software that connects directly to Dash Platform, a decentralized blockchain network. There is no
          company, organization, or central authority operating this platform. No one controls the network, moderates content, or
          has special access to user data. The software is provided as a tool for interacting with the Dash Platform blockchain.
        </Prose>
      </InfoSection>

      <InfoSection title="You Are Responsible">
        <Prose className="space-y-3">
          <p>When you use Yappr, you are directly interacting with a blockchain. This comes with important responsibilities:</p>
          <ul className="list-disc list-inside space-y-2 ml-2">
            <li>
              <strong>Your private key is your identity.</strong> If you lose it, there is no way to recover your account. No one can reset
              your password or restore access.
            </li>
            <li>
              <strong>You own your content.</strong> Everything you post is signed with your private key and stored on the blockchain
              under your identity.
            </li>
            <li>
              <strong>You are responsible for your actions.</strong> Content you post reflects on you and is permanently associated
              with your identity.
            </li>
          </ul>
        </Prose>
      </InfoSection>

      <InfoSection title="Data Is Permanent">
        <Prose>
          Posts, likes, follows, and other interactions are stored on the Dash Platform blockchain. Once something is written to the
          blockchain, it cannot be deleted or modified. Think carefully before you post. Even if content is hidden in the app
          interface, it remains on the blockchain and can be viewed by anyone with the technical knowledge to query it directly.
        </Prose>
      </InfoSection>

      <InfoSection title="No Content Moderation">
        <Prose>
          Because there is no central authority, there is no content moderation. No one can delete posts, ban users, or remove content
          from the blockchain. Users have tools to manage their own experience (such as blocking), but these only affect what you see,
          not what exists on the network. Other users and applications may still display content you&apos;ve blocked.
        </Prose>
      </InfoSection>

      <InfoSection title="Transaction Costs">
        <Prose>
          Creating posts, updating your profile, and other actions require Dash Platform credits. These credits are a form of
          cryptocurrency used to pay for storing data on the blockchain. You are responsible for maintaining sufficient credits in
          your identity to perform actions. On testnet, credits can be obtained from faucets for free.
        </Prose>
      </InfoSection>

      <InfoSection title="No Warranty">
        <Prose>
          This software is provided &quot;as is&quot; without warranty of any kind. The developers make no guarantees about availability,
          reliability, or fitness for any particular purpose. Use at your own risk. The decentralized nature of the platform means
          that issues cannot always be fixed or data recovered.
        </Prose>
      </InfoSection>
    </InfoPage>
  )
}
