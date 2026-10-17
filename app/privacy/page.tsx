'use client'

import Link from 'next/link'
import { ShieldCheckIcon, EyeIcon, LockClosedIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { InfoPage, InfoSection, Prose, BulletList, NetworkNotice } from '@/components/layout/info-page'
import { IPFS_GATEWAYS } from '@/lib/utils/ipfs-gateway'
import { LEGAL_UPDATED, SUPPORT_EMAIL, SUPPORT_MAILTO } from '@/lib/legal'

const PUBLIC_DATA = [
  'Your username, identity ID and credit balance',
  'Your profile: name, bio, avatar, banner, website, location, links and payment addresses',
  'Your posts, replies and quotes, and the media they link to',
  'Who you follow, who follows you, and follow requests to private feeds',
  'Likes, bookmarks and poll votes',
  'Who you block, and any note you add to a block',
  'Reports you file: what you reported, why, and your details',
  'Who you approve to read your private feed',
  'Your blogs, blog posts and comments',
  'Your store and items, the reviews you write, and that you ordered from a store and when',
  'The time of every action',
]

interface ThirdParty {
  name: string
  what: string
}

const THIRD_PARTIES: ThirdParty[] = [
  {
    name: 'Dash Platform nodes',
    what: 'Every read and write goes to the network’s nodes. The nodes that answer you see your IP address and what you ask for.',
  },
  {
    name: 'GitHub Pages and Cloudflare',
    what: 'yap.pr is hosted on GitHub Pages and delivered through Cloudflare (some copies of the site run on Cloudflare Pages). Like any web host, they see your IP address and the pages you load.',
  },
  {
    name: 'Cloudflare Web Analytics',
    what: 'Counts page views and measures how fast pages load. It sets no cookies and builds no profile of you; it records the page address, the referring site, your browser and device type, and your country.',
  },
  {
    name: 'wsrv.nl',
    what: 'Images from other websites are loaded through this public image proxy, so those websites don’t see your IP address. wsrv.nl sees the image address and your IP address.',
  },
  {
    name: 'IPFS gateways',
    what: `Images and files stored on IPFS load from public gateways (${IPFS_GATEWAYS.map((gateway) => gateway.domain).join(', ')}). They see your IP address and what you load.`,
  },
  {
    name: 'Storacha and Pinata',
    what: 'Only if you connect your own account to upload media. Uploads go from your browser to that service, under its terms.',
  },
  {
    name: 'YouTube',
    what: 'For YouTube links, the thumbnail loads from YouTube. The video player loads from youtube-nocookie.com only when you press play.',
  },
  {
    name: 'Link previews',
    what: 'When a post links to a page, your browser may fetch a preview from that site. You can turn previews off in Settings › Privacy.',
  },
  {
    name: 'CoinGecko and CryptoCompare',
    what: 'When a payment code shows an approximate value in your currency, the price comes from these services.',
  },
  {
    name: 'Google Fonts',
    what: 'Blogs that use a custom font load it from Google Fonts, which sees your IP address.',
  },
  {
    name: 'Getting an identity',
    what: 'The sign-in screen links to a separate site for getting a Dash identity: on test networks, an identity bridge funded by a faucet. It has its own terms.',
  },
]

export default function PrivacyPage() {
  return (
    <InfoPage icon={ShieldCheckIcon} title="Privacy Policy" subtitle="What is public on Yappr, what is private, and who sees what" updated={LEGAL_UPDATED}>
      <NetworkNotice>
        {({ where }) => (
          <>
            This release of Yappr runs on {where}. The privacy rules below apply in full, so don&apos;t post anything you
            wouldn&apos;t want public.
          </>
        )}
      </NetworkNotice>

      <InfoSection title="The short version">
        <Prose>
          <BulletList>
            <li>Almost everything you do on Yappr is public and permanent, because it is written to Dash Platform.</li>
            <li>Messages, private-feed posts and order details are encrypted, but some facts about them are still visible.</li>
            <li>We have no accounts database, no ads, and we don&apos;t sell or share your data.</li>
            <li>Your keys stay on your device. We never receive them.</li>
            <li>We use Cloudflare Web Analytics to count visits. It sets no cookies.</li>
          </BulletList>
        </Prose>
      </InfoSection>

      <InfoSection title="Public by design" icon={EyeIcon}>
        <Prose className="space-y-3">
          <p>
            Yappr writes to Dash Platform, a public ledger that anyone can read with Yappr or any other tool. Everything below is
            public and linked to your identity:
          </p>
          <BulletList>
            {PUBLIC_DATA.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </BulletList>
        </Prose>
      </InfoSection>

      <InfoSection title="What is encrypted, and its limits" icon={LockClosedIcon} iconClassName="text-green-500">
        <Prose className="space-y-4">
          <div>
            <p className="font-medium text-gray-700 dark:text-gray-300">Direct messages</p>
            <p className="mt-1">
              Message content, and who you are talking to, are hidden from people reading the network. Some things still show:
            </p>
            <BulletList>
              <li>that you send messages, how many, when, and roughly how long they are;</li>
              <li>
                the network nodes your app asks for new messages can, over time, work out who you talk to and which groups you are in;
              </li>
              <li>if two people often write moments apart, someone watching closely could guess they are talking;</li>
              <li>
                everyone in a conversation or group can read it, and keeps their copy; group members see messages from when they joined;
              </li>
              <li>
                anyone who gets your encryption key can read your whole message history. Keep it as safe as your sign-in key.
              </li>
            </BulletList>
          </div>
          <div>
            <p className="font-medium text-gray-700 dark:text-gray-300">Private feeds</p>
            <p className="mt-1">
              Private posts can only be read by the followers you approve. That you posted, when, who you approved, and who asked to
              follow are public. Followers you remove keep whatever they could already read.
            </p>
            <p className="mt-2">
              <strong>Reports open private posts to moderators.</strong> If someone reports one of your private posts, the report gives
              the moderators the key to read it. That key also opens your other private posts from the same period and all earlier
              ones.
            </p>
          </div>
          <div>
            <p className="font-medium text-gray-700 dark:text-gray-300">Orders and addresses</p>
            <p className="mt-1">
              What you ordered and your shipping address are encrypted so only you and the seller can read them. That you placed an
              order with a store, when, and its status are public. Saved addresses are encrypted so only you can read them.
            </p>
          </div>
        </Prose>
      </InfoSection>

      <InfoSection title="Reports">
        <Prose>
          A report is public. The person you report can see that you reported them, the reason you chose and anything you wrote. How
          the moderators resolved it is public too. Reports expire after 90 days. To report something privately, email{' '}
          <a href={SUPPORT_MAILTO} className="underline">{SUPPORT_EMAIL}</a>.
        </Prose>
      </InfoSection>

      <InfoSection title="Deleting">
        <Prose className="space-y-3">
          <p>
            You can delete your posts, replies, likes, follows, bookmarks, blocks and more. A deleted item disappears from Yappr and
            from the network&apos;s current data, though a deleted post may leave a small marker behind. It does not disappear from
            the network&apos;s history, or from anyone who already saw, saved or copied it.
          </p>
          <p>
            When moderators remove something, a few details (such as when it was posted) stay, along with a public record of the
            removal. Your Dash identity
            itself can&apos;t be deleted.
          </p>
        </Prose>
      </InfoSection>

      <InfoSection title="On your device">
        <Prose>
          Yappr keeps your keys, settings, drafts and caches in your browser so it can work without a server. Signing out removes your
          keys. The <Link href="/cookies" className="underline">Cookies &amp; Storage</Link> page lists exactly what is stored and
          for how long. The Yappr mobile apps keep keys in the phone&apos;s secure storage.
        </Prose>
      </InfoSection>

      <InfoSection title="Services your device talks to" icon={GlobeAltIcon}>
        <Prose className="space-y-3">
          <p>Yappr has no servers of its own. To work, your browser or app connects to these services:</p>
          <dl className="space-y-3">
            {THIRD_PARTIES.map((party) => (
              <div key={party.name}>
                <dt className="font-medium text-gray-700 dark:text-gray-300">{party.name}</dt>
                <dd className="text-sm mt-0.5">{party.what}</dd>
              </div>
            ))}
          </dl>
        </Prose>
      </InfoSection>

      <InfoSection title="Contact">
        <Prose>
          Questions about privacy, or a request about your data: <a href={SUPPORT_MAILTO} className="underline">{SUPPORT_EMAIL}</a>.
          We can&apos;t change or delete what is on Dash Platform, but we will explain what is possible and pass requests to the
          moderators where they can help.
        </Prose>
      </InfoSection>
    </InfoPage>
  )
}
