'use client'

import Link from 'next/link'
import { DocumentTextIcon } from '@heroicons/react/24/outline'
import { InfoPage, InfoSection, Prose, BulletList, NetworkNotice, testNetwork } from '@/components/layout/info-page'
import { SupportEmailLink } from '@/components/layout/legal-links'
import { LEGAL_UPDATED, MINIMUM_AGE } from '@/lib/legal'
import {
  declaredActionFee,
  electedModeration,
  starterGrantAmount,
  tokenCostFor,
  yappIsLocked,
  yappIsTransferable,
  type ElectedModerationDeclaration,
} from '@/lib/contract-topology'

const COMMUNITY_RULES = [
  { title: 'Nothing illegal', body: 'Don’t post, sell or link to anything that is illegal where you or the people you share it with live.' },
  {
    title: 'No sexual content involving minors',
    body: 'Zero tolerance. It is removed, the account is banned, and it may be reported to the authorities.',
  },
  { title: 'No harassment or bullying', body: 'Don’t target, insult, intimidate or pile on other people, and don’t publish someone’s private information.' },
  { title: 'No hate', body: 'Don’t attack people for who they are, such as their race, ethnicity, religion, gender, sexuality or disability.' },
  { title: 'No violence or threats', body: 'Don’t threaten, incite or glorify violence.' },
  { title: 'No promotion of self-harm', body: 'Don’t encourage suicide or self-injury.' },
  { title: 'No spam or scams', body: 'No repetitive or misleading content, fake giveaways, phishing or fraud.' },
  { title: 'No impersonation', body: 'Don’t pretend to be another person or organisation.' },
  {
    title: 'Mark sensitive content',
    body: 'Mark posts with nudity, gore or other graphic content as sensitive, so Yappr hides them until each viewer chooses to see them.',
  },
  { title: 'Respect other people’s rights', body: 'Only post what you have the right to share, including other people’s photos, writing and trademarks.' },
]

/** Who moderates before a team is seated, as the configured social contract declares it. */
const INTERIM_COPY: Record<ElectedModerationDeclaration['interim'] | 'none', string> = {
  notYetUsable: 'Until a team is elected and seated, the parts of Yappr it moderates (such as posting) stay closed.',
  contractOwner: 'Until a team is elected and seated, the contract’s owner moderates in its place.',
  appointedModerators: 'Until a team is elected and seated, moderators appointed by the contract’s owner moderate in its place.',
  noModeration: 'Until a team is elected and seated, nobody moderates.',
  none: '',
}

/** What YAPP costs and is, as the configured contract declares it. */
function yappCostCopy(): string {
  const cost = tokenCostFor('post')
  if (!cost) return ''
  const sentences = [
    cost.optional
      ? 'Posting, replying and liking can be paid in YAPP, Yappr’s in-app token.'
      : 'Posting, replying and liking are paid in YAPP, Yappr’s in-app token.',
  ]
  if (starterGrantAmount() !== null) sentences.push('New accounts get a starter amount.')
  if (cost.gasFeesPaidBy !== 0) sentences.push('While you pay in YAPP, the network fee is usually covered for you.')
  if (cost.optional) sentences.push('Once your YAPP runs out, or if you choose, you pay in credits.')
  if (yappIsLocked()) sentences.push('YAPP has no monetary value, and Yappr never sells it.')
  if (!yappIsTransferable()) sentences.push('YAPP can’t be sent to other people.')
  return ` ${sentences.join(' ')}`
}

export default function TermsPage() {
  const network = testNetwork()
  return (
    <InfoPage icon={DocumentTextIcon} title="Terms of Use" subtitle="The rules for using Yappr, in plain words" updated={LEGAL_UPDATED}>
      <NetworkNotice>
        {({ where }) => (
          <>
            This release of Yappr runs on {where}. Credits and test DASH have no monetary value. The network can be reset, and
            Yappr&apos;s mainnet launch may start fresh, so don&apos;t count on anything you post here being kept.
          </>
        )}
      </NetworkNotice>

      <InfoSection title="About these terms">
        <Prose className="space-y-3">
          <p>
            These terms cover the Yappr app at yap.pr and the official Yappr apps. &quot;We&quot; means the people who maintain
            Yappr. By signing in or posting, you agree to these terms and the <a href="#community-rules" className="underline">Community Rules</a>{' '}
            below. Our <Link href="/privacy" className="underline">Privacy Policy</Link> explains what is public and what is not.
          </p>
        </Prose>
      </InfoSection>

      <InfoSection title="What Yappr is">
        <Prose className="space-y-3">
          <p>
            Yappr is software that runs in your browser and reads and writes to Dash Platform, a public, shared network. Its source
            code is public on GitHub. Your posts, likes, follows and profile are records on Dash Platform, not on our servers. We
            don&apos;t run servers that store them, and we can&apos;t edit what you write.
          </p>
          <p>
            Other apps can read and display the same records. These terms cover the apps we publish, not anyone else&apos;s.
          </p>
        </Prose>
      </InfoSection>

      <InfoSection title="Who can use Yappr">
        <Prose>
          You must be at least {MINIMUM_AGE} years old, and able to agree to these terms where you live. Don&apos;t use Yappr if the
          law, or a ban from Yappr&apos;s moderators, says you can&apos;t.
        </Prose>
      </InfoSection>

      <InfoSection title="Your identity and keys">
        <Prose>
          <BulletList>
            <li>
              <strong>Your keys are your account.</strong> You sign in with your Dash identity&apos;s private key. Nobody, including us,
              can reset it or recover it if you lose it.
            </li>
            <li>
              <strong>Keep them safe.</strong> Anyone with your keys can post as you and spend your credits. Sign out on devices you
              share.
            </li>
            <li>
              <strong>You are responsible for what you do with them.</strong> Everything signed with your keys is attributed to your
              identity.
            </li>
          </BulletList>
        </Prose>
      </InfoSection>

      <InfoSection title="Your content">
        <Prose className="space-y-3">
          <p>
            You own what you post. Because Dash Platform is public, anyone, using Yappr or another app, can read, display, share and
            quote it. By posting, you agree to that.
          </p>
          <p>
            Treat everything you post as public and permanent. You can delete your posts and most other actions, but deleting does not
            erase them from the network&apos;s history or from people who already saw or saved them. The{' '}
            <Link href="/privacy" className="underline">Privacy Policy</Link> explains what deleting does.
          </p>
        </Prose>
      </InfoSection>

      <InfoSection title="Community Rules" id="community-rules">
        <Prose className="space-y-3">
          <p>These rules apply to everything on Yappr: posts, replies, profiles, messages, blogs, stores, items and reviews.</p>
          <BulletList>
            {COMMUNITY_RULES.map((rule) => (
              <li key={rule.title}>
                <strong>{rule.title}.</strong> {rule.body}
              </li>
            ))}
          </BulletList>
          <p>Breaking them can get your content removed and your account warned, suspended or banned.</p>
        </Prose>
      </InfoSection>

      <InfoSection title="Moderation">
        <Prose className="space-y-3">
          <p>
            Yappr&apos;s social network, blogs and stores each get a moderation team, elected on Dash Platform. Each team publishes a
            charter, and every removal, warning, suspension or ban it makes must cite one of the charter&apos;s reasons. Moderators
            can:
          </p>
          <BulletList>
            <li>remove posts, replies and the Yappr parts of a profile (such as the banner, website and links);</li>
            <li>remove blogs, blog posts and comments;</li>
            <li>remove stores, items and reviews;</li>
            <li>warn, suspend or ban an account from the part of Yappr they moderate.</li>
          </BulletList>
          <p>
            Moderation happens in the open. Every removal, warning, suspension or ban leaves a public record of who did it, to what,
            and when. Removing a post or reply
            that is more than a week old needs the team&apos;s leader and two more moderators to agree.
          </p>
          <p>
            {INTERIM_COPY[electedModeration()?.interim ?? 'none']} We can also stop
            showing content or media in the apps we publish when it breaks these rules or the law, but we can&apos;t remove anything
            from Dash Platform ourselves.
          </p>
        </Prose>
      </InfoSection>

      <InfoSection title="Reporting and takedown requests">
        <Prose className="space-y-3">
          <p>
            Use <strong>Report</strong> on a post, reply or profile to send it to the moderators. Reports are public: the person you
            report can see that you reported them, the reason you chose and anything you wrote.
          </p>
          <p>
            For blogs, stores, reviews and messages, for anything urgent or private, for copyright and other legal requests, or if
            reporting isn&apos;t open yet, email <SupportEmailLink /> with a link to the content and what is wrong with it. We review
            it, pass it to the moderators once a team is seated, and may stop showing it in our apps. If a child is in danger,
            contact your local police first.
          </p>
        </Prose>
      </InfoSection>

      <InfoSection title="Stores and payments">
        <Prose className="space-y-3">
          <BulletList>
            <li>
              <strong>Yappr is not a party to any sale.</strong> Stores are run by their owners. A purchase is an agreement between
              you and the seller.
            </li>
            <li>
              <strong>You pay the seller directly</strong>, from your own wallet to the address the seller lists. We never hold the
              money, and there is no escrow, refund or chargeback through Yappr. Sort out problems with the seller.
            </li>
            <li>
              <strong>Sellers are responsible</strong> for what they sell, for delivering it, and for following the law, including
              tax, consumer protection, and shipping rules.
            </li>
            <li>
              <strong>Reviews are public</strong> and tied to an order. Store moderators can remove stores, items and reviews that
              break the Community Rules.
            </li>
            {network && (
              <li>
                <strong>
                  On {network}, test DASH has no value, but a seller can list real payment addresses, including mainnet Dash and other
                  cryptocurrencies.
                </strong>{' '}
                Check before you send anything of value.
              </li>
            )}
          </BulletList>
          <p>Tips work the same way: they go straight from your wallet to the address the person lists.</p>
        </Prose>
      </InfoSection>

      <InfoSection title="Costs">
        <Prose>
          Writing to Dash Platform costs credits, paid from your identity&apos;s balance.
          {declaredActionFee('post', 'create') && ' Some actions also carry a small moderation fee that goes to the elected moderators.'}
          {yappCostCopy()}
          {network && ` On ${network}, credits are free: you can get them through the identity bridge linked from the sign-in screen.`}
        </Prose>
      </InfoSection>

      <InfoSection title="No warranty">
        <Prose>
          Yappr is provided free of charge and &quot;as is&quot;, without any warranty. It may have bugs, be unavailable, or
          change. Because it runs on a public network that nobody fully controls, mistakes can&apos;t always be undone and data
          can&apos;t always be recovered. To the extent the law allows, we are not liable for any loss that comes from using Yappr,
          including lost keys, lost funds, or content posted by others.
        </Prose>
      </InfoSection>

      <InfoSection title="Changes and contact">
        <Prose>
          We may update these terms. The date below shows the last change, and continuing to use Yappr after a change means you accept
          it. Questions: <SupportEmailLink />.
        </Prose>
      </InfoSection>
    </InfoPage>
  )
}
