'use client'

import { ArrowLeftIcon, LockClosedIcon, KeyIcon, ShieldCheckIcon, QuestionMarkCircleIcon, CpuChipIcon, ArrowPathIcon, ExclamationTriangleIcon, CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { motion } from 'framer-motion'

// Reusable Components
function CalloutBox({
  title,
  children,
  variant = 'blue'
}: {
  title?: string
  children: React.ReactNode
  variant?: 'blue' | 'green' | 'yellow'
}) {
  const colors = {
    blue: 'bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-100',
    green: 'bg-green-50 dark:bg-green-950/50 border-green-200 dark:border-green-800 text-green-900 dark:text-green-100',
    yellow: 'bg-yellow-50 dark:bg-yellow-950/50 border-yellow-200 dark:border-yellow-800 text-yellow-900 dark:text-yellow-100',
  }
  return (
    <div className={`${colors[variant]} border rounded-xl p-6 my-6`}>
      {title && <h4 className="font-semibold mb-2">{title}</h4>}
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  )
}

function FlowBox({
  title,
  steps,
  note
}: {
  title: string
  steps: (string | { text: string; sub?: string[] })[]
  note?: string
}) {
  return (
    <div className="my-4 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="bg-gray-100 dark:bg-gray-800 px-4 py-2 font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </div>
      <div className="p-4">
        <ol className="space-y-2">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 text-sm flex items-center justify-center">
                {i + 1}
              </span>
              <div className="flex-1">
                {typeof step === 'string' ? (
                  <span>{step}</span>
                ) : (
                  <>
                    <span>{step.text}</span>
                    {step.sub && (
                      <ul className="mt-1 ml-2 space-y-1 text-sm text-gray-500 dark:text-gray-500">
                        {step.sub.map((subItem, j) => (
                          <li key={j} className="flex gap-2">
                            <span className="text-gray-400">•</span>
                            {subItem}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
        {note && (
          <p className="mt-4 pt-3 border-t border-gray-200 dark:border-gray-700 text-sm text-gray-500 dark:text-gray-500">
            {note}
          </p>
        )}
      </div>
    </div>
  )
}

function Section({
  icon: Icon,
  title,
  children,
  id
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
  id?: string
}) {
  const sectionId = id || title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return (
    <section className="scroll-mt-8" id={sectionId}>
      <div className="flex items-center gap-2 mb-3">
        {Icon && <Icon className="h-5 w-5 text-gray-500" />}
        <h2 className="text-xl font-semibold">{title}</h2>
      </div>
      <div className="text-gray-600 dark:text-gray-400 leading-relaxed space-y-4">
        {children}
      </div>
    </section>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h3 className="text-lg font-medium text-gray-800 dark:text-gray-200 mb-2">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

export default function PrivateFeedsPage() {
  return (
    <div className="min-h-screen bg-surface-1 dark:bg-surface-2">
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Back link */}
        <div className="mb-8">
          <Link
            href="/about"
            className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back to About
          </Link>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-surface-0 dark:bg-surface-1 rounded-2xl shadow-lg overflow-hidden"
        >
          {/* Header */}
          <div className="bg-gradient-yappr p-8 text-white">
            <div className="flex items-center gap-3 mb-4">
              <LockClosedIcon className="h-8 w-8" />
              <h1 className="text-3xl font-bold">How Private Feeds Work</h1>
            </div>
            <p className="text-lg opacity-90">
              End-to-end encrypted content sharing with efficient revocation on a public blockchain
            </p>
          </div>

          {/* Content */}
          <div className="p-8 space-y-10">
            {/* Section 1: The Challenge */}
            <Section icon={QuestionMarkCircleIcon} title="The Challenge: Privacy on a Public Blockchain">
              <p>
                Yappr stores all data on Dash Platform—a public blockchain. Unlike a traditional database
                where you can set permissions on who sees what, blockchain data is visible to everyone.
                Anyone running a node can read every document ever created.
              </p>
              <p>
                So how do you share content with only specific people when the storage medium is inherently public?
              </p>
              <p>
                Traditional social networks solve this with access control: their servers check who you are
                before showing you content. But Yappr has no servers. There&apos;s no gatekeeper to enforce
                &quot;only show this to my approved followers.&quot;
              </p>
              <p>
                The answer is cryptography. Instead of controlling <em>who can access</em> the data, we control{' '}
                <em>who can understand</em> it. Private posts are encrypted before they&apos;re stored on the
                blockchain. Only approved followers have the keys to decrypt them.
              </p>
              <p>
                But this creates new problems. How do you share keys with hundreds of followers efficiently?
                And crucially—how do you <em>revoke</em> access when you no longer want someone reading your posts?
              </p>

              <CalloutBox title="The Core Insight">
                On a public blockchain, you can&apos;t hide data—you can only make it unreadable to those
                without the right keys.
              </CalloutBox>
            </Section>

            {/* Section 2: Naive Solutions */}
            <Section icon={ExclamationTriangleIcon} title="Why Simple Solutions Don't Work">
              <p>
                Before explaining how private feeds actually work, let&apos;s explore why the obvious
                approaches fail. Understanding these constraints helps appreciate why the real solution
                is designed the way it is.
              </p>

              <SubSection title="Solution 1: Encrypt for Each Follower">
                <p>
                  <strong>The Idea:</strong> When you create a private post, encrypt it separately for
                  each follower using their public key. This is how encrypted email works—each recipient
                  gets their own encrypted copy.
                </p>
                <p>
                  <strong>The Fatal Flaw:</strong> Storage explodes. With 1,000 followers, every post
                  requires 1,000 separate encrypted copies stored on the blockchain. A 500-character
                  post becomes 500KB of data. Post ten times a day for a year, and you&apos;ve used
                  nearly 2GB of blockchain storage—just for your posts.
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500">
                  <strong>Cost:</strong> O(N) storage per post, where N is your follower count.
                </p>
              </SubSection>

              <SubSection title="Solution 2: Share One Key">
                <p>
                  <strong>The Idea:</strong> Generate a single &quot;private feed key&quot; and share it
                  with all your approved followers. They all use the same key to decrypt your posts.
                </p>
                <p>
                  <strong>The Fatal Flaw:</strong> Revocation is impossible. Once someone has your key,
                  they have it forever. You can&apos;t &quot;un-share&quot; a secret. If you change the
                  key, you&apos;d need to re-share it with all remaining followers—and they&apos;d lose
                  access to all your old posts encrypted with the previous key.
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500">
                  <strong>Cost:</strong> Revocation requires O(N) key distribution.
                </p>
              </SubSection>

              <SubSection title="Solution 3: Re-encrypt Everything">
                <p>
                  <strong>The Idea:</strong> When you revoke someone, generate a new key, re-encrypt
                  all your past posts with it, and share the new key with everyone still approved.
                </p>
                <p>
                  <strong>The Fatal Flaw:</strong> This requires modifying every historical post on
                  every revocation. With 1,000 posts and 1,000 followers, revoking one person means
                  1,000 re-encryption operations plus 999 key distributions.
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-500">
                  <strong>Cost:</strong> O(posts × followers) work per revocation.
                </p>
              </SubSection>

              <div className="my-6 overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-100 dark:bg-gray-800">
                      <th className="text-left p-3 font-semibold border border-gray-200 dark:border-gray-700">Approach</th>
                      <th className="text-left p-3 font-semibold border border-gray-200 dark:border-gray-700">Post Cost</th>
                      <th className="text-left p-3 font-semibold border border-gray-200 dark:border-gray-700">Revoke Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="p-3 border border-gray-200 dark:border-gray-700">Encrypt per-follower</td>
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono text-red-600 dark:text-red-400">O(N)</td>
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono">O(1)</td>
                    </tr>
                    <tr className="bg-gray-50 dark:bg-gray-900">
                      <td className="p-3 border border-gray-200 dark:border-gray-700">Share one key</td>
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono">O(1)</td>
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono text-red-600 dark:text-red-400">O(N) or impossible</td>
                    </tr>
                    <tr>
                      <td className="p-3 border border-gray-200 dark:border-gray-700">Re-encrypt on revoke</td>
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono">O(1)</td>
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono text-red-600 dark:text-red-400">O(posts × N)</td>
                    </tr>
                    <tr className="bg-green-50 dark:bg-green-950/30">
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-semibold text-green-700 dark:text-green-300">What we need</td>
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono font-semibold text-green-700 dark:text-green-300">O(1)</td>
                      <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono font-semibold text-green-700 dark:text-green-300">O(log N)</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p>
                The pattern is clear: these approaches all have the wrong scaling factor somewhere.
                We need O(1) cost for creating posts AND efficient revocation. This seems impossible—but it&apos;s not.
              </p>
            </Section>

            {/* Section 3: The Key Insight */}
            <Section icon={KeyIcon} title="The Solution: Manage Keys, Not Content">
              <p>
                The breakthrough comes from reframing the problem. Instead of thinking about encrypting{' '}
                <em>content</em> for people, think about managing <em>keys</em> that unlock content.
              </p>
              <p>
                Here&apos;s the insight: encrypt your posts with a single key (the Content Encryption Key,
                or CEK). Then separately manage who has access to that CEK. When you revoke someone, you
                don&apos;t touch the content—you update the key and control who learns the new one.
              </p>
              <p>
                This is called &quot;broadcast encryption&quot; or &quot;multicast key management.&quot;
                It&apos;s the same problem cable companies solved decades ago: they can&apos;t send different
                signals to each home, so they send one encrypted signal and manage who has the keys to
                decrypt it. When you stop paying, they update the keys without telling you.
              </p>
              <p>
                The specific technique Yappr uses is called a <strong>Logical Key Hierarchy (LKH)</strong>—a
                binary tree structure that makes revocation cost O(log N) instead of O(N).
              </p>

              <CalloutBox title="Analogy: The Building with Security Checkpoints">
                <p>
                  Imagine a building where a vault sits at the center, but to reach it you must pass
                  through a series of locked doors. Each employee gets keys for a unique path of doors
                  leading to the vault.
                </p>
                <p className="mt-2">
                  When someone leaves the company, you don&apos;t change every lock in the building.
                  You only change the locks on the doors <em>they</em> knew about. Then you pass new
                  keys to remaining employees through adjacent hallways they can still access.
                </p>
                <p className="mt-2">
                  This is exactly how our key tree works.
                </p>
              </CalloutBox>
            </Section>

            {/* Section 4: The Binary Key Tree */}
            <Section title="The Key Tree Structure">
              <p>
                The key tree is a binary tree with 1,024 leaf positions—each leaf can be assigned to
                one follower. The tree looks like this:
              </p>

              {/* Tree Diagram - SVG-based for proper rendering */}
              <div className="my-6 p-6 bg-surface-1 dark:bg-surface-2 rounded-xl border border-border">
                <svg viewBox="0 0 600 320" className="w-full max-w-2xl mx-auto" style={{ minHeight: '280px' }}>
                  {/* Connection lines */}
                  <g stroke="currentColor" strokeWidth="2" fill="none" className="text-gray-300 dark:text-gray-600">
                    {/* Root to children */}
                    <path d="M300,50 L300,70 L150,70 L150,90" />
                    <path d="M300,50 L300,70 L450,70 L450,90" />
                    {/* Node A to children */}
                    <path d="M150,120 L150,140 L90,140 L90,160" />
                    <path d="M150,120 L150,140 L210,140 L210,160" />
                    {/* Node B to children */}
                    <path d="M450,120 L450,140 L390,140 L390,160" />
                    <path d="M450,120 L450,140 L510,140 L510,160" />
                    {/* Node C to slots */}
                    <path d="M90,190 L90,230" strokeDasharray="4,4" />
                    <path d="M90,250 L90,260 L60,260 L60,275" />
                    <path d="M90,250 L90,260 L120,260 L120,275" />
                    {/* Node F to slots */}
                    <path d="M510,190 L510,230" strokeDasharray="4,4" />
                    <path d="M510,250 L510,260 L480,260 L480,275" />
                    <path d="M510,250 L510,260 L540,260 L540,275" />
                  </g>

                  {/* Root node */}
                  <g transform="translate(300, 30)">
                    <rect x="-35" y="-15" width="70" height="35" rx="8" className="fill-yappr-500" />
                    <text x="0" y="5" textAnchor="middle" className="fill-white text-sm font-semibold">Root</text>
                  </g>
                  <text x="300" y="65" textAnchor="middle" className="fill-gray-500 dark:fill-gray-400 text-xs">All approved followers know this</text>

                  {/* Level 1 nodes */}
                  <g transform="translate(150, 105)">
                    <rect x="-40" y="-15" width="80" height="30" rx="6" className="fill-blue-500 dark:fill-blue-600" />
                    <text x="0" y="5" textAnchor="middle" className="fill-white text-sm font-medium">Node A</text>
                  </g>
                  <g transform="translate(450, 105)">
                    <rect x="-40" y="-15" width="80" height="30" rx="6" className="fill-blue-500 dark:fill-blue-600" />
                    <text x="0" y="5" textAnchor="middle" className="fill-white text-sm font-medium">Node B</text>
                  </g>

                  {/* Level 2 nodes */}
                  <g transform="translate(90, 175)">
                    <rect x="-35" y="-15" width="70" height="28" rx="5" className="fill-gray-200 dark:fill-gray-700" />
                    <text x="0" y="4" textAnchor="middle" className="fill-gray-700 dark:fill-gray-200 text-xs font-medium">Node C</text>
                  </g>
                  <g transform="translate(210, 175)">
                    <rect x="-35" y="-15" width="70" height="28" rx="5" className="fill-gray-200 dark:fill-gray-700" />
                    <text x="0" y="4" textAnchor="middle" className="fill-gray-700 dark:fill-gray-200 text-xs font-medium">Node D</text>
                  </g>
                  <g transform="translate(390, 175)">
                    <rect x="-35" y="-15" width="70" height="28" rx="5" className="fill-gray-200 dark:fill-gray-700" />
                    <text x="0" y="4" textAnchor="middle" className="fill-gray-700 dark:fill-gray-200 text-xs font-medium">Node E</text>
                  </g>
                  <g transform="translate(510, 175)">
                    <rect x="-35" y="-15" width="70" height="28" rx="5" className="fill-gray-200 dark:fill-gray-700" />
                    <text x="0" y="4" textAnchor="middle" className="fill-gray-700 dark:fill-gray-200 text-xs font-medium">Node F</text>
                  </g>

                  {/* Ellipsis for middle levels */}
                  <text x="90" y="245" textAnchor="middle" className="fill-gray-400 dark:fill-gray-500 text-sm">...</text>
                  <text x="210" y="215" textAnchor="middle" className="fill-gray-400 dark:fill-gray-500 text-sm">...</text>
                  <text x="390" y="215" textAnchor="middle" className="fill-gray-400 dark:fill-gray-500 text-sm">...</text>
                  <text x="510" y="245" textAnchor="middle" className="fill-gray-400 dark:fill-gray-500 text-sm">...</text>

                  {/* Leaf slots - Alice */}
                  <g transform="translate(60, 290)">
                    <rect x="-28" y="-15" width="56" height="26" rx="5" className="fill-green-500 dark:fill-green-600" />
                    <text x="0" y="3" textAnchor="middle" className="fill-white text-xs font-medium">Slot 1</text>
                  </g>
                  <text x="60" y="315" textAnchor="middle" className="fill-green-600 dark:fill-green-400 text-xs font-medium">Alice</text>

                  {/* Leaf slots - empty */}
                  <g transform="translate(120, 290)">
                    <rect x="-28" y="-15" width="56" height="26" rx="5" className="fill-gray-300 dark:fill-gray-600" />
                    <text x="0" y="3" textAnchor="middle" className="fill-gray-600 dark:fill-gray-300 text-xs">Slot 2</text>
                  </g>

                  {/* Leaf slots - ellipsis and Bob */}
                  <g transform="translate(480, 290)">
                    <rect x="-20" y="-15" width="40" height="26" rx="5" className="fill-gray-300 dark:fill-gray-600" />
                    <text x="0" y="3" textAnchor="middle" className="fill-gray-500 dark:fill-gray-400 text-xs">...</text>
                  </g>
                  <g transform="translate(540, 290)">
                    <rect x="-35" y="-15" width="70" height="26" rx="5" className="fill-orange-500 dark:fill-orange-600" />
                    <text x="0" y="3" textAnchor="middle" className="fill-white text-xs font-medium">Slot 1024</text>
                  </g>
                  <text x="540" y="315" textAnchor="middle" className="fill-orange-600 dark:fill-orange-400 text-xs font-medium">Bob</text>
                </svg>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 text-center">Binary key tree structure with 1,024 leaf slots</p>
              </div>

              <p>
                When Alice is approved for your private feed, she&apos;s assigned a leaf slot (say, slot 1).
                She then receives the keys for every node on the path from her slot to the root—about 10 keys total:
              </p>

              {/* Path Diagram */}
              <div className="my-6 p-6 bg-surface-1 dark:bg-surface-2 rounded-xl border border-border">
                <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-5">Alice knows these keys (slot 1):</p>
                <div className="relative ml-4">
                  {/* Vertical connecting line */}
                  <div className="absolute left-[52px] top-[20px] bottom-[20px] w-0.5 bg-gradient-to-b from-yappr-500 via-gray-300 to-green-500 dark:via-gray-600" />

                  <div className="space-y-4">
                    {/* Root */}
                    <div className="flex items-center gap-4 relative">
                      <div className="relative z-10 px-4 py-2 bg-yappr-500 text-white rounded-lg text-sm font-semibold shadow-sm min-w-[105px] text-center">
                        Root
                      </div>
                      <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
                        <span className="text-gray-400">&larr;</span>
                        The master key that unlocks content
                      </span>
                    </div>

                    {/* Node A */}
                    <div className="flex items-center gap-4 relative pl-4">
                      <div className="relative z-10 px-4 py-2 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded-lg text-sm font-medium min-w-[85px] text-center">
                        Node A
                      </div>
                      <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
                        <span className="text-gray-400">&larr;</span>
                        Intermediate key on Alice&apos;s path
                      </span>
                    </div>

                    {/* Node C */}
                    <div className="flex items-center gap-4 relative pl-8">
                      <div className="relative z-10 px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg text-sm font-medium min-w-[85px] text-center">
                        Node C
                      </div>
                    </div>

                    {/* Ellipsis */}
                    <div className="flex items-center gap-4 relative pl-12">
                      <div className="relative z-10 px-4 py-1 text-gray-400 dark:text-gray-500 text-lg font-bold">
                        ...
                      </div>
                    </div>

                    {/* Slot 1 */}
                    <div className="flex items-center gap-4 relative pl-16">
                      <div className="relative z-10 px-4 py-2 bg-green-500 dark:bg-green-600 text-white rounded-lg text-sm font-semibold min-w-[85px] text-center shadow-sm">
                        Slot 1
                      </div>
                      <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
                        <span className="text-gray-400">&larr;</span>
                        Alice&apos;s unique leaf key
                      </span>
                    </div>
                  </div>
                </div>
                <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-red-600 dark:text-red-400">
                    <strong>Alice does NOT know:</strong> <span className="text-gray-600 dark:text-gray-400">Node B, Node D, Node E, etc. (these are on other followers&apos; paths)</span>
                  </p>
                </div>
              </div>

              <p>
                Every follower reaches the root through a different path. They all know the root key
                (which unlocks content), but they reach it via different intermediate keys. This is
                what makes efficient revocation possible.
              </p>
            </Section>

            {/* Section 5: The Epoch System */}
            <Section icon={ArrowPathIcon} title="Epochs: Forward Secrecy Through Time">
              <p>
                The root key doesn&apos;t directly encrypt posts. Instead, it unlocks a{' '}
                <strong>Content Encryption Key (CEK)</strong> for the current &quot;epoch.&quot; Each
                time you revoke someone, the epoch advances, and a new CEK is used for future posts.
              </p>
              <p>
                CEKs are connected in a clever way called a hash chain:
              </p>

              {/* Hash Chain Diagram */}
              <div className="my-6 p-6 bg-surface-1 dark:bg-surface-2 rounded-xl border border-border">
                <h4 className="text-xs font-bold uppercase tracking-wider text-center text-gray-500 dark:text-gray-400 mb-6">Hash Chain</h4>
                <div className="flex flex-col items-center">
                  {/* CEK[2000] */}
                  <div className="flex items-center gap-4">
                    <div className="px-4 py-2 bg-gray-200 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-lg font-mono text-sm">
                      CEK[2000]
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-500">Pre-generated at setup</span>
                  </div>

                  {/* Arrow with SHA256 */}
                  <div className="flex flex-col items-center my-2">
                    <div className="w-0.5 h-3 bg-gray-300 dark:bg-gray-600" />
                    <div className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-500 dark:text-gray-400 font-mono">SHA256</div>
                    <div className="text-gray-400 dark:text-gray-500 text-lg leading-none">↓</div>
                  </div>

                  {/* CEK[1999] */}
                  <div className="flex items-center gap-4">
                    <div className="px-4 py-2 bg-gray-200 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-lg font-mono text-sm">
                      CEK[1999]
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-500">= SHA256(CEK[2000])</span>
                  </div>

                  {/* Arrow with SHA256 */}
                  <div className="flex flex-col items-center my-2">
                    <div className="w-0.5 h-3 bg-gray-300 dark:bg-gray-600" />
                    <div className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-500 dark:text-gray-400 font-mono">SHA256</div>
                    <div className="text-gray-400 dark:text-gray-500 text-lg leading-none">↓</div>
                  </div>

                  {/* Dots */}
                  <div className="text-gray-400 dark:text-gray-500 text-2xl tracking-widest my-1">⋮</div>

                  {/* Arrow */}
                  <div className="flex flex-col items-center my-2">
                    <div className="text-gray-400 dark:text-gray-500 text-lg leading-none">↓</div>
                  </div>

                  {/* CEK[2] */}
                  <div className="flex items-center gap-4">
                    <div className="px-4 py-2 bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 rounded-lg font-mono text-sm font-medium">
                      CEK[2]
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400">After first revocation</span>
                  </div>

                  {/* Arrow with SHA256 */}
                  <div className="flex flex-col items-center my-2">
                    <div className="w-0.5 h-3 bg-gray-300 dark:bg-gray-600" />
                    <div className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-500 dark:text-gray-400 font-mono">SHA256</div>
                    <div className="text-gray-400 dark:text-gray-500 text-lg leading-none">↓</div>
                  </div>

                  {/* CEK[1] - highlighted */}
                  <div className="flex items-center gap-4">
                    <div className="px-4 py-2 bg-yappr-500 text-white rounded-lg font-mono text-sm font-semibold shadow-sm">
                      CEK[1]
                    </div>
                    <span className="text-xs text-yappr-600 dark:text-yappr-400 font-medium">Initial epoch (feed starts here)</span>
                  </div>
                </div>

                <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    <strong className="text-gray-700 dark:text-gray-300">Epoch numbers increase over time:</strong> 1 → 2 → 3 → ... (higher = newer content)
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3 text-sm">
                    <div className="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-950/30 rounded-lg border border-green-200 dark:border-green-800">
                      <span className="text-green-600 dark:text-green-400 font-bold">✓</span>
                      <span className="text-green-700 dark:text-green-300">CEK[5] → CEK[4] → CEK[3]</span>
                      <span className="text-green-600/70 dark:text-green-400/70 text-xs">(CAN derive older)</span>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-2 bg-red-50 dark:bg-red-950/30 rounded-lg border border-red-200 dark:border-red-800">
                      <span className="text-red-600 dark:text-red-400 font-bold">✗</span>
                      <span className="text-red-700 dark:text-red-300">CEK[3] → CEK[4] → CEK[5]</span>
                      <span className="text-red-600/70 dark:text-red-400/70 text-xs">(CANNOT derive newer)</span>
                    </div>
                  </div>
                </div>
              </div>

              <p>
                Epoch numbers increase over time (1 → 2 → 3 ...). Higher epochs correspond to newer
                content. The chain has a crucial property:
              </p>
              <ul className="list-disc list-inside space-y-2 pl-4">
                <li>
                  <strong>Backward derivation works:</strong> If you learn CEK[5], you can compute
                  CEK[4] by hashing. You can keep going back to derive CEK[3], CEK[2], CEK[1]—all
                  the older epochs.
                </li>
                <li>
                  <strong>Forward derivation is impossible:</strong> If you only have CEK[3], you cannot
                  figure out CEK[4] or CEK[5]. There&apos;s no mathematical way to reverse SHA256.
                </li>
              </ul>
              <p>
                Why does this matter? When we revoke someone at epoch 3, we advance to epoch 4. The revoked
                user has CEK[3], so they can still derive older keys (CEK[2], CEK[1]) and read historical
                posts. But they can&apos;t derive CEK[4]—they&apos;re locked out of all future content.
              </p>

              <CalloutBox title="Forward Secrecy" variant="green">
                Revoked users cannot read posts created after their revocation, even though they still
                have their old keys.
              </CalloutBox>
            </Section>

            {/* Section 6: How Revocation Works */}
            <Section title="Revocation: The Elegant Part">
              <p>
                Now for the clever bit. When you revoke Alice, you need to:
              </p>
              <ol className="list-decimal list-inside space-y-2 pl-4">
                <li>Advance to a new epoch (so Alice can&apos;t derive the new CEK)</li>
                <li>Share the new CEK with remaining followers (without telling Alice)</li>
              </ol>
              <p>
                But how do you share a new key with Bob without Alice intercepting it? Remember,
                everything goes on the public blockchain.
              </p>
              <p>
                The answer uses the tree structure. Here&apos;s what happens:
              </p>

              {/* Revocation Before/After Diagram */}
              <div className="my-6 grid md:grid-cols-2 gap-4">
                {/* Before */}
                <div className="p-5 bg-surface-1 dark:bg-surface-2 rounded-xl border border-border">
                  <div className="text-center mb-4">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">Before Revocation</h4>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">(Epoch 1)</p>
                  </div>
                  <svg viewBox="0 0 280 180" className="w-full" style={{ maxHeight: '180px' }}>
                    {/* Lines */}
                    <g stroke="currentColor" strokeWidth="2" fill="none" className="text-gray-300 dark:text-gray-600">
                      <path d="M140,35 L140,50 L70,50 L70,70" />
                      <path d="M140,35 L140,50 L210,50 L210,70" />
                      <path d="M70,100 L70,115 L40,115 L40,130" />
                      <path d="M70,100 L70,115 L100,115 L100,130" />
                      <path d="M210,100 L210,115 L210,130" />
                    </g>

                    {/* Root */}
                    <g transform="translate(140, 22)">
                      <rect x="-45" y="-12" width="90" height="26" rx="5" className="fill-gray-200 dark:fill-gray-700" />
                      <text x="0" y="5" textAnchor="middle" className="fill-gray-700 dark:fill-gray-200 text-xs font-medium">Root (v1)</text>
                    </g>

                    {/* Node 2 */}
                    <g transform="translate(70, 85)">
                      <rect x="-45" y="-12" width="90" height="26" rx="5" className="fill-gray-200 dark:fill-gray-700" />
                      <text x="0" y="5" textAnchor="middle" className="fill-gray-700 dark:fill-gray-200 text-xs font-medium">Node 2 (v1)</text>
                    </g>

                    {/* Node 3 */}
                    <g transform="translate(210, 85)">
                      <rect x="-45" y="-12" width="90" height="26" rx="5" className="fill-gray-200 dark:fill-gray-700" />
                      <text x="0" y="5" textAnchor="middle" className="fill-gray-700 dark:fill-gray-200 text-xs font-medium">Node 3 (v1)</text>
                    </g>

                    {/* Alice - highlighted for revocation */}
                    <g transform="translate(40, 148)">
                      <rect x="-35" y="-14" width="70" height="28" rx="5" className="fill-red-100 dark:fill-red-900/50" />
                      <text x="0" y="4" textAnchor="middle" className="fill-red-700 dark:fill-red-300 text-xs font-medium">Alice (v1)</text>
                    </g>
                    <text x="40" y="175" textAnchor="middle" className="fill-red-500 text-xs font-bold">↑ REVOKED</text>

                    {/* Bob */}
                    <g transform="translate(100, 148)">
                      <rect x="-30" y="-14" width="60" height="28" rx="5" className="fill-gray-100 dark:fill-gray-800" />
                      <text x="0" y="4" textAnchor="middle" className="fill-gray-600 dark:fill-gray-300 text-xs">Bob (v1)</text>
                    </g>

                    {/* Carol */}
                    <g transform="translate(210, 148)">
                      <rect x="-35" y="-14" width="70" height="28" rx="5" className="fill-gray-100 dark:fill-gray-800" />
                      <text x="0" y="4" textAnchor="middle" className="fill-gray-600 dark:fill-gray-300 text-xs">Carol (v1)</text>
                    </g>
                  </svg>
                </div>

                {/* After */}
                <div className="p-5 bg-green-50 dark:bg-green-950/30 rounded-xl border border-green-200 dark:border-green-800">
                  <div className="text-center mb-4">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-green-700 dark:text-green-300">After Revoking Alice</h4>
                    <p className="text-xs text-green-600/70 dark:text-green-400/70 mt-1">(Epoch 2)</p>
                  </div>
                  <svg viewBox="0 0 280 180" className="w-full" style={{ maxHeight: '180px' }}>
                    {/* Lines */}
                    <g stroke="currentColor" strokeWidth="2" fill="none" className="text-gray-300 dark:text-gray-600">
                      <path d="M140,35 L140,50 L70,50 L70,70" />
                      <path d="M140,35 L140,50 L210,50 L210,70" />
                      <path d="M70,100 L70,115 L40,115 L40,130" />
                      <path d="M70,100 L70,115 L100,115 L100,130" />
                      <path d="M210,100 L210,115 L210,130" />
                    </g>

                    {/* Root - NEW */}
                    <g transform="translate(140, 22)">
                      <rect x="-45" y="-12" width="90" height="26" rx="5" className="fill-green-500 dark:fill-green-600" />
                      <text x="0" y="5" textAnchor="middle" className="fill-white text-xs font-semibold">Root (v2)</text>
                    </g>
                    <text x="195" y="26" className="fill-green-600 dark:fill-green-400 text-xs font-medium">New!</text>

                    {/* Node 2 - NEW */}
                    <g transform="translate(70, 85)">
                      <rect x="-45" y="-12" width="90" height="26" rx="5" className="fill-green-500 dark:fill-green-600" />
                      <text x="0" y="5" textAnchor="middle" className="fill-white text-xs font-semibold">Node 2 (v2)</text>
                    </g>
                    <text x="125" y="89" className="fill-green-600 dark:fill-green-400 text-xs font-medium">New!</text>

                    {/* Node 3 - Same */}
                    <g transform="translate(210, 85)">
                      <rect x="-45" y="-12" width="90" height="26" rx="5" className="fill-gray-200 dark:fill-gray-700" />
                      <text x="0" y="5" textAnchor="middle" className="fill-gray-700 dark:fill-gray-200 text-xs font-medium">Node 3 (v1)</text>
                    </g>
                    <text x="265" y="89" className="fill-gray-400 dark:fill-gray-500 text-xs">Same</text>

                    {/* Alice - revoked */}
                    <g transform="translate(40, 148)">
                      <rect x="-35" y="-14" width="70" height="28" rx="5" className="fill-red-100 dark:fill-red-900/30" strokeDasharray="4,2" stroke="currentColor" strokeWidth="1" style={{ stroke: 'rgb(239 68 68 / 0.5)' }} />
                      <text x="0" y="4" textAnchor="middle" className="fill-red-400 dark:fill-red-500 text-xs line-through">Alice (v1)</text>
                    </g>
                    <text x="40" y="175" textAnchor="middle" className="fill-red-500 dark:fill-red-400 text-xs">Can&apos;t decrypt</text>

                    {/* Bob */}
                    <g transform="translate(100, 148)">
                      <rect x="-30" y="-14" width="60" height="28" rx="5" className="fill-gray-100 dark:fill-gray-800" />
                      <text x="0" y="4" textAnchor="middle" className="fill-gray-600 dark:fill-gray-300 text-xs">Bob (v1)</text>
                    </g>

                    {/* Carol */}
                    <g transform="translate(210, 148)">
                      <rect x="-35" y="-14" width="70" height="28" rx="5" className="fill-gray-100 dark:fill-gray-800" />
                      <text x="0" y="4" textAnchor="middle" className="fill-gray-600 dark:fill-gray-300 text-xs">Carol (v1)</text>
                    </g>
                  </svg>
                </div>
              </div>

              <SubSection title="Step by step:">
                <ol className="list-decimal list-inside space-y-2 pl-4">
                  <li>
                    <strong>Identify the revoked path:</strong> Alice&apos;s path is Leaf→Node 2→Root
                  </li>
                  <li>
                    <strong>Generate new versions:</strong> Create new keys for Node 2 (v2) and Root (v2)
                  </li>
                  <li>
                    <strong>Share Node 2 v2 via sibling leaf:</strong> Alice and Bob both know Node 2 v1
                    and Root v1, so we can&apos;t encrypt under those. But Bob has his own leaf key that
                    Alice doesn&apos;t know! We encrypt &quot;new Node 2 v2&quot; under Bob&apos;s leaf key.
                    Bob can decrypt it; Alice cannot.
                  </li>
                  <li>
                    <strong>Share Root v2 via sibling subtrees:</strong> Now we need to distribute the
                    new Root key. We encrypt &quot;new Root v2&quot; under &quot;new Node 2 v2&quot;
                    (which Bob just learned) and under &quot;old Node 3 v1&quot; (which Carol knows).
                    Alice doesn&apos;t have access to either of these keys.
                  </li>
                  <li>
                    <strong>Encrypt new CEK under new Root:</strong> Finally, encrypt CEK[epoch 2] under Root v2.
                  </li>
                </ol>
              </SubSection>

              {/* Rekey Packets */}
              <div className="my-6 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <div className="bg-gray-100 dark:bg-gray-800 px-4 py-2 font-semibold text-sm">
                  Rekey packets posted to blockchain:
                </div>
                <div className="p-4 space-y-3">
                  {[
                    {
                      packet: 1,
                      content: <><code className="text-xs bg-green-100 dark:bg-green-900 px-1 rounded">new_Node2_v2</code> encrypted under <code className="text-xs bg-blue-100 dark:bg-blue-900 px-1 rounded">Bob_leaf</code></>,
                      who: 'Bob',
                      why: 'Alice doesn\'t know his leaf key',
                    },
                    {
                      packet: 2,
                      content: <><code className="text-xs bg-green-100 dark:bg-green-900 px-1 rounded">new_Root_v2</code> encrypted under <code className="text-xs bg-green-100 dark:bg-green-900 px-1 rounded">new_Node2_v2</code></>,
                      who: 'Bob',
                      why: 'He just learned Node2 v2',
                    },
                    {
                      packet: 3,
                      content: <><code className="text-xs bg-green-100 dark:bg-green-900 px-1 rounded">new_Root_v2</code> encrypted under <code className="text-xs bg-gray-200 dark:bg-gray-700 px-1 rounded">old_Node3_v1</code></>,
                      who: 'Carol',
                      why: 'She knows Node3, Alice doesn\'t',
                    },
                    {
                      packet: 4,
                      content: <><code className="text-xs bg-yappr-100 dark:bg-yappr-900 px-1 rounded">CEK[epoch2]</code> encrypted under <code className="text-xs bg-green-100 dark:bg-green-900 px-1 rounded">new_Root_v2</code></>,
                      who: 'Anyone with Root v2',
                      why: null,
                    },
                  ].map((item) => (
                    <div key={item.packet} className="flex gap-3 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-sm font-medium">
                        {item.packet}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm">{item.content}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          → <span className="text-green-600 dark:text-green-400">{item.who}</span> can decrypt
                          {item.why && <span className="text-gray-400"> ({item.why})</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-3 bg-red-50 dark:bg-red-950/30 border-t border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-red-700 dark:text-red-300">
                    <strong>Alice can read these packets, but can&apos;t decrypt ANY of them.</strong>
                    <span className="text-red-600 dark:text-red-400"> She doesn&apos;t have Bob&apos;s leaf key, Node3, or the new versions.</span>
                  </p>
                </div>
              </div>

              <p>
                The result: approximately 20 small &quot;rekey packets&quot; posted to the blockchain.
                Every remaining follower can decrypt one of them, learn the new keys, and access future
                content. Alice is completely locked out.
              </p>

              <CalloutBox title="Cost comparison">
                <ul className="space-y-1">
                  <li><strong>Naive approach:</strong> Contact 999 followers individually = O(N)</li>
                  <li><strong>LKH approach:</strong> Post ~20 packets = O(log N)</li>
                </ul>
              </CalloutBox>
            </Section>

            {/* Section 7: Complete Flows */}
            <Section title="Putting It All Together">
              <p>
                Let&apos;s walk through each operation with concrete examples. Alice is the feed owner;
                Bob and Carol are followers.
              </p>

              <FlowBox
                title="Enable Private Feed"
                steps={[
                  'Generate random 256-bit seed (master secret)',
                  'Derive tree node keys from seed',
                  'Pre-compute hash chain: CEK[2000] → CEK[1]',
                  'Encrypt seed to your own public key (for recovery)',
                  'Store encrypted seed on blockchain',
                  'Local state: epoch=1, all 1024 slots available',
                ]}
              />

              <FlowBox
                title="Grant Access (Alice approves Bob)"
                steps={[
                  'Pick available leaf slot (say, slot 2)',
                  'Compute path keys: slot → intermediate nodes → root',
                  'Bundle: path keys + current CEK + current epoch',
                  'Encrypt bundle to Bob\'s public key (ECIES)',
                  'Store grant document on blockchain',
                  'Mark slot 2 as assigned to Bob',
                ]}
                note="Bob receives ~500 bytes containing everything needed to decrypt all current and past private posts."
              />

              <FlowBox
                title="Create Private Post"
                steps={[
                  'Get CEK for current epoch',
                  'Generate random nonce (prevents duplicate keys)',
                  { text: 'Derive post key:', sub: ['HKDF(CEK, "post" || nonce || authorId)'] },
                  { text: 'Encrypt with XChaCha20-Poly1305' },
                  { text: 'Store on blockchain:', sub: ['encryptedContent (ciphertext)', 'epoch (which CEK version)', 'nonce (for key derivation)', 'teaser (optional public preview)'] },
                ]}
              />

              <FlowBox
                title="Decrypt Post (Bob reading Alice's post)"
                steps={[
                  'Check post\'s epoch vs Bob\'s cached epoch',
                  'If behind: fetch rekey documents, apply them',
                  { text: 'Derive CEK for post\'s epoch:', sub: ['If same as cached: use cached CEK', 'If older: hash backward from cached CEK'] },
                  { text: 'Derive post key:', sub: ['HKDF(CEK, "post" || nonce || ownerId)'] },
                  'Decrypt with XChaCha20-Poly1305',
                  'If decryption fails: show teaser or "locked" icon',
                ]}
              />

              <FlowBox
                title="Revoke Access (Alice revokes Bob)"
                steps={[
                  'Look up Bob\'s leaf slot (slot 2)',
                  'Increment epoch: 1 → 2',
                  'Compute Bob\'s path to root',
                  'Generate new versions for each node on path',
                  { text: 'Create rekey packets (~20 packets):', sub: ['Each new key encrypted under sibling subtree keys'] },
                  'Encrypt new CEK under new root key',
                  'Store rekey document on blockchain',
                  'Delete Bob\'s grant document',
                  'Return slot 2 to available pool',
                ]}
                note="Total cost: 2 blockchain operations + local computation"
              />
            </Section>

            {/* Section 8: Security Guarantees */}
            <Section icon={ShieldCheckIcon} title="What's Protected (And What Isn't)">
              <div className="grid md:grid-cols-2 gap-6">
                <div className="bg-green-50 dark:bg-green-950/30 rounded-lg p-4">
                  <h4 className="font-semibold text-green-800 dark:text-green-200 mb-3 flex items-center gap-2">
                    <CheckCircleIcon className="h-5 w-5" />
                    Protected
                  </h4>
                  <ul className="space-y-2 text-sm text-green-700 dark:text-green-300">
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">✓</span>
                      Revoked users cannot decrypt posts created after revocation
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">✓</span>
                      Non-approved users cannot decrypt private posts
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">✓</span>
                      Content is authenticated (tampering is detected)
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">✓</span>
                      Each post uses a unique key (compromising one doesn&apos;t expose others)
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-green-600 mt-0.5">✓</span>
                      Multi-device recovery (seed encrypted for owner&apos;s key)
                    </li>
                  </ul>
                </div>

                <div className="bg-gray-100 dark:bg-gray-800/50 rounded-lg p-4">
                  <h4 className="font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                    <XCircleIcon className="h-5 w-5" />
                    Not Protected
                  </h4>
                  <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                    <li className="flex items-start gap-2">
                      <span className="text-gray-500 mt-0.5">✗</span>
                      Approved followers sharing content (screenshots, copy-paste)
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-gray-500 mt-0.5">✗</span>
                      Metadata is visible (who follows you, when posts were made, etc.)
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-gray-500 mt-0.5">✗</span>
                      Revoked users keep access to posts from when they were approved
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-gray-500 mt-0.5">✗</span>
                      Compromised devices (if malware has your keys, game over)
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-gray-500 mt-0.5">✗</span>
                      Owner&apos;s seed compromise (would expose entire feed)
                    </li>
                  </ul>
                </div>
              </div>

              <CalloutBox title="Design Philosophy" variant="yellow">
                We protect against cryptographic attacks, not social attacks. If someone you trusted
                shares your content with others, that&apos;s a human problem no encryption can solve.
                Private feeds ensure that only the people you approve can read your posts—what they
                do with that access is up to them.
              </CalloutBox>
            </Section>

            {/* Section 9: Technical Reference */}
            <Section icon={CpuChipIcon} title="Under the Hood">
              <SubSection title="What Gets Written to the Chain?">
                <p>
                  Four document types power the private feed system:
                </p>
                <ul className="space-y-3 mt-4">
                  <li className="bg-surface-1 dark:bg-surface-2 rounded-lg p-4">
                    <strong className="text-gray-900 dark:text-gray-100">PrivateFeedState</strong>
                    <p className="text-sm mt-1">
                      Created once when enabling private feed. Contains the encrypted seed (for owner recovery),
                      tree capacity, and initial state. ~300 bytes.
                    </p>
                  </li>
                  <li className="bg-surface-1 dark:bg-surface-2 rounded-lg p-4">
                    <strong className="text-gray-900 dark:text-gray-100">PrivateFeedGrant</strong>
                    <p className="text-sm mt-1">
                      Created for each approved follower. Contains their leaf slot assignment and an encrypted
                      bundle of path keys + current CEK. ~500 bytes per follower.
                    </p>
                  </li>
                  <li className="bg-surface-1 dark:bg-surface-2 rounded-lg p-4">
                    <strong className="text-gray-900 dark:text-gray-100">PrivateFeedRekey</strong>
                    <p className="text-sm mt-1">
                      Created on each revocation. Contains rekey packets (new keys encrypted for sibling subtrees),
                      the new epoch number, and a state snapshot for recovery. ~1-2 KB.
                    </p>
                  </li>
                  <li className="bg-surface-1 dark:bg-surface-2 rounded-lg p-4">
                    <strong className="text-gray-900 dark:text-gray-100">Post</strong>
                    <span className="text-xs ml-2 text-gray-500">(extended)</span>
                    <p className="text-sm mt-1">
                      Private posts add fields to the standard post document: <code className="text-xs bg-gray-200 dark:bg-gray-800 px-1 rounded">encryptedContent</code>,{' '}
                      <code className="text-xs bg-gray-200 dark:bg-gray-800 px-1 rounded">epoch</code>,{' '}
                      <code className="text-xs bg-gray-200 dark:bg-gray-800 px-1 rounded">nonce</code>, and optional public{' '}
                      <code className="text-xs bg-gray-200 dark:bg-gray-800 px-1 rounded">teaser</code>.
                    </p>
                  </li>
                </ul>
              </SubSection>

              <SubSection title="Cryptographic Primitives">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-gray-100 dark:bg-gray-800">
                        <th className="text-left p-3 font-semibold border border-gray-200 dark:border-gray-700">Purpose</th>
                        <th className="text-left p-3 font-semibold border border-gray-200 dark:border-gray-700">Algorithm</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="p-3 border border-gray-200 dark:border-gray-700 align-top">Content encryption</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700">
                          <div className="font-mono text-sm">XChaCha20-Poly1305</div>
                          <div className="text-xs text-gray-500 mt-1">256-bit key, 192-bit nonce</div>
                        </td>
                      </tr>
                      <tr className="bg-gray-50 dark:bg-gray-900">
                        <td className="p-3 border border-gray-200 dark:border-gray-700 align-top">Key derivation</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700">
                          <div className="font-mono text-sm">HKDF-SHA256</div>
                          <div className="text-xs text-gray-500 mt-1">Context strings prevent misuse</div>
                        </td>
                      </tr>
                      <tr>
                        <td className="p-3 border border-gray-200 dark:border-gray-700 align-top">Epoch chain</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700">
                          <div className="font-mono text-sm">SHA256 hash chain</div>
                          <div className="text-xs text-gray-500 mt-1">2000 epochs pre-generated</div>
                        </td>
                      </tr>
                      <tr className="bg-gray-50 dark:bg-gray-900">
                        <td className="p-3 border border-gray-200 dark:border-gray-700 align-top">Key exchange</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700">
                          <div className="font-mono text-sm">ECIES (ECDH + XChaCha20-Poly1305)</div>
                          <div className="text-xs text-gray-500 mt-1">secp256k1 curve (same as Dash)</div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </SubSection>

              <SubSection title="Capacity Limits">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-gray-100 dark:bg-gray-800">
                        <th className="text-left p-3 font-semibold border border-gray-200 dark:border-gray-700">Limit</th>
                        <th className="text-left p-3 font-semibold border border-gray-200 dark:border-gray-700">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="p-3 border border-gray-200 dark:border-gray-700">Maximum private followers</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono">1,024</td>
                      </tr>
                      <tr className="bg-gray-50 dark:bg-gray-900">
                        <td className="p-3 border border-gray-200 dark:border-gray-700">Maximum epochs (revocations)</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono">2,000</td>
                      </tr>
                      <tr>
                        <td className="p-3 border border-gray-200 dark:border-gray-700">Rekey packets per revocation</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono">~20</td>
                      </tr>
                      <tr className="bg-gray-50 dark:bg-gray-900">
                        <td className="p-3 border border-gray-200 dark:border-gray-700">Grant document size</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono">~500 bytes</td>
                      </tr>
                      <tr>
                        <td className="p-3 border border-gray-200 dark:border-gray-700">Rekey document size</td>
                        <td className="p-3 border border-gray-200 dark:border-gray-700 font-mono">~1-2 KB</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </SubSection>
            </Section>

            {/* Footer / Resources */}
            <div className="pt-6 border-t border-border">
              <h2 className="text-xl font-semibold mb-4">Resources</h2>
              <div className="grid md:grid-cols-2 gap-4">
                <a
                  href="https://github.com/pastapastapasta/yappr/blob/master/docs/YAPPR_PRIVATE_FEED_SPEC_v1.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-surface-1 dark:bg-surface-2 rounded-lg p-4 hover:bg-surface-1 dark:hover:bg-surface-2 transition-colors"
                >
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Full Technical Specification</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Complete protocol details, data structures, and algorithms
                  </p>
                </a>
                <a
                  href="https://github.com/pastapastapasta/yappr"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-surface-1 dark:bg-surface-2 rounded-lg p-4 hover:bg-surface-1 dark:hover:bg-surface-2 transition-colors"
                >
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Yappr on GitHub</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Source code, issues, and contributions
                  </p>
                </a>
                <a
                  href="https://dashplatform.readme.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-surface-1 dark:bg-surface-2 rounded-lg p-4 hover:bg-surface-1 dark:hover:bg-surface-2 transition-colors"
                >
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Dash Platform Documentation</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Learn about the underlying blockchain technology
                  </p>
                </a>
              </div>
              <p className="text-sm text-gray-500 mt-6">Last updated: January 2026</p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
