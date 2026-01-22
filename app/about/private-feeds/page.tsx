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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
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
          className="bg-white dark:bg-neutral-900 rounded-2xl shadow-lg overflow-hidden"
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

              {/* Tree Diagram */}
              <div className="my-6 p-6 bg-gray-50 dark:bg-gray-950 rounded-lg overflow-x-auto">
                <div className="min-w-[500px]">
                  {/* Root */}
                  <div className="flex flex-col items-center">
                    <div className="px-4 py-2 bg-yappr-500 text-white rounded-lg font-semibold text-sm">
                      Root
                    </div>
                    <div className="text-xs text-gray-500 mt-1">All approved followers know this</div>
                    <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                    {/* Level 1 */}
                    <div className="flex gap-16">
                      <div className="flex flex-col items-center">
                        <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                        <div className="px-3 py-1.5 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded text-sm">Node A</div>
                        <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                        {/* Level 2 */}
                        <div className="flex gap-8">
                          <div className="flex flex-col items-center">
                            <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                            <div className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs">Node C</div>
                            <div className="w-px h-3 bg-gray-300 dark:bg-gray-600" />
                            <div className="text-gray-400 text-xs">...</div>
                            <div className="w-px h-3 bg-gray-300 dark:bg-gray-600" />
                            <div className="flex gap-2">
                              <div className="flex flex-col items-center">
                                <div className="px-2 py-1 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded text-xs font-medium">Slot 1</div>
                                <div className="text-xs text-green-600 dark:text-green-400 mt-1">Alice</div>
                              </div>
                              <div className="flex flex-col items-center">
                                <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">Slot 2</div>
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-col items-center">
                            <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                            <div className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs">Node D</div>
                            <div className="text-gray-400 text-xs mt-2">...</div>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col items-center">
                        <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                        <div className="px-3 py-1.5 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded text-sm">Node B</div>
                        <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                        <div className="flex gap-8">
                          <div className="flex flex-col items-center">
                            <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                            <div className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs">Node E</div>
                            <div className="text-gray-400 text-xs mt-2">...</div>
                          </div>
                          <div className="flex flex-col items-center">
                            <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                            <div className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs">Node F</div>
                            <div className="text-gray-400 text-xs mt-2">...</div>
                            <div className="w-px h-3 bg-gray-300 dark:bg-gray-600" />
                            <div className="flex gap-2">
                              <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">...</div>
                              <div className="flex flex-col items-center">
                                <div className="px-2 py-1 bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 rounded text-xs font-medium">Slot 1024</div>
                                <div className="text-xs text-orange-600 dark:text-orange-400 mt-1">Bob</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <p className="text-sm text-gray-500 mt-4 text-center">Binary key tree structure with 1,024 leaf slots</p>
              </div>

              <p>
                When Alice is approved for your private feed, she&apos;s assigned a leaf slot (say, slot 1).
                She then receives the keys for every node on the path from her slot to the root—about 10 keys total:
              </p>

              {/* Path Diagram */}
              <div className="my-6 p-6 bg-gray-50 dark:bg-gray-950 rounded-lg">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-4">Alice knows these keys (slot 1):</p>
                <div className="flex flex-col items-start gap-1 ml-4">
                  {[
                    { key: 'Root', desc: 'The master key that unlocks content', highlight: true },
                    { key: 'Node A', desc: 'Intermediate key on Alice\'s path' },
                    { key: 'Node C', desc: null },
                    { key: '...', desc: null, dim: true },
                    { key: 'Slot 1', desc: 'Alice\'s unique leaf key' },
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-3">
                      {i > 0 && <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 ml-6 -my-1" />}
                      <div className={`flex items-center gap-3 ${i > 0 ? 'mt-1' : ''}`}>
                        <div className={`px-3 py-1 rounded text-sm font-mono ${
                          item.highlight ? 'bg-yappr-500 text-white' :
                          item.dim ? 'text-gray-400' :
                          'bg-gray-200 dark:bg-gray-700'
                        }`}>
                          {item.key}
                        </div>
                        {item.desc && (
                          <span className="text-sm text-gray-500">← {item.desc}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-gray-500">
                    <strong>Alice does NOT know:</strong> Node B, Node D, Node E, etc. (these are on other followers&apos; paths)
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
              <div className="my-6 p-6 bg-gray-50 dark:bg-gray-950 rounded-lg">
                <h4 className="text-sm font-semibold text-center text-gray-700 dark:text-gray-300 mb-4">HASH CHAIN</h4>
                <div className="flex flex-col items-center gap-2">
                  {[
                    { key: 'CEK[2000]', desc: 'Pre-generated at setup (future use)', style: 'dim' },
                    { arrow: true, label: 'SHA256' },
                    { key: 'CEK[1999]', desc: '= SHA256(CEK[2000])', style: 'dim' },
                    { arrow: true, label: 'SHA256' },
                    { dots: true },
                    { arrow: true },
                    { key: 'CEK[2]', desc: 'After first revocation', style: 'normal' },
                    { arrow: true, label: 'SHA256' },
                    { key: 'CEK[1]', desc: 'Initial epoch (feed starts here)', style: 'highlight' },
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-3">
                      {item.arrow && (
                        <div className="flex flex-col items-center">
                          <div className="w-px h-3 bg-gray-400 dark:bg-gray-500" />
                          {item.label && <span className="text-xs text-gray-500 my-1">{item.label}</span>}
                          <div className="text-gray-400">↓</div>
                        </div>
                      )}
                      {item.dots && (
                        <span className="text-gray-400 text-lg">⋮</span>
                      )}
                      {item.key && (
                        <div className="flex items-center gap-3">
                          <div className={`px-3 py-1.5 rounded font-mono text-sm ${
                            item.style === 'highlight' ? 'bg-yappr-500 text-white' :
                            item.style === 'dim' ? 'bg-gray-200 dark:bg-gray-800 text-gray-500' :
                            'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200'
                          }`}>
                            {item.key}
                          </div>
                          {item.desc && <span className="text-sm text-gray-500">← {item.desc}</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    <strong>Epoch numbers increase over time:</strong> 1 → 2 → 3 → ... (higher = newer content)
                  </p>
                  <div className="flex flex-col sm:flex-row gap-4 text-sm">
                    <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                      <span>✓</span>
                      <span>CEK[5] → CEK[4] → CEK[3] <span className="text-gray-500">(CAN derive older)</span></span>
                    </div>
                    <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                      <span>✗</span>
                      <span>CEK[3] → CEK[4] → CEK[5] <span className="text-gray-500">(CANNOT derive newer)</span></span>
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
                <div className="p-4 bg-gray-50 dark:bg-gray-950 rounded-lg">
                  <h4 className="text-sm font-semibold text-center mb-1">BEFORE REVOCATION</h4>
                  <p className="text-xs text-gray-500 text-center mb-4">(Epoch 1)</p>
                  <div className="flex flex-col items-center">
                    <div className="px-3 py-1 bg-gray-200 dark:bg-gray-700 rounded text-sm">Root (v1)</div>
                    <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                    <div className="flex gap-8">
                      <div className="flex flex-col items-center">
                        <div className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs">Node 2 (v1)</div>
                        <div className="w-px h-3 bg-gray-300 dark:bg-gray-600" />
                        <div className="flex gap-4 text-xs">
                          <div className="flex flex-col items-center">
                            <div className="px-2 py-1 bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 rounded">Alice (v1)</div>
                            <span className="text-red-500 text-xs mt-1">↑ REVOKED</span>
                          </div>
                          <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded">Bob (v1)</div>
                        </div>
                      </div>
                      <div className="flex flex-col items-center">
                        <div className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs">Node 3 (v1)</div>
                        <div className="w-px h-3 bg-gray-300 dark:bg-gray-600" />
                        <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">Carol (v1)</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* After */}
                <div className="p-4 bg-green-50 dark:bg-green-950/30 rounded-lg">
                  <h4 className="text-sm font-semibold text-center mb-1">AFTER REVOKING ALICE</h4>
                  <p className="text-xs text-gray-500 text-center mb-4">(Epoch 2)</p>
                  <div className="flex flex-col items-center">
                    <div className="flex items-center gap-2">
                      <div className="px-3 py-1 bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 rounded text-sm font-medium">Root (v2)</div>
                      <span className="text-xs text-green-600 dark:text-green-400">← New!</span>
                    </div>
                    <div className="w-px h-4 bg-gray-300 dark:bg-gray-600" />
                    <div className="flex gap-8">
                      <div className="flex flex-col items-center">
                        <div className="flex items-center gap-1">
                          <div className="px-2 py-1 bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 rounded text-xs font-medium">Node 2 (v2)</div>
                          <span className="text-xs text-green-600 dark:text-green-400">← New!</span>
                        </div>
                        <div className="w-px h-3 bg-gray-300 dark:bg-gray-600" />
                        <div className="flex gap-4 text-xs">
                          <div className="flex flex-col items-center">
                            <div className="px-2 py-1 bg-red-100 dark:bg-red-900/50 text-red-400 rounded line-through">Alice (v1)</div>
                            <span className="text-xs text-red-500 mt-1">Can&apos;t decrypt</span>
                          </div>
                          <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded">Bob (v1)</div>
                        </div>
                      </div>
                      <div className="flex flex-col items-center">
                        <div className="flex items-center gap-1">
                          <div className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-xs">Node 3 (v1)</div>
                          <span className="text-xs text-gray-500">← Same</span>
                        </div>
                        <div className="w-px h-3 bg-gray-300 dark:bg-gray-600" />
                        <div className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs">Carol (v1)</div>
                      </div>
                    </div>
                  </div>
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
                  <li className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
                    <strong className="text-gray-900 dark:text-gray-100">PrivateFeedState</strong>
                    <p className="text-sm mt-1">
                      Created once when enabling private feed. Contains the encrypted seed (for owner recovery),
                      tree capacity, and initial state. ~300 bytes.
                    </p>
                  </li>
                  <li className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
                    <strong className="text-gray-900 dark:text-gray-100">PrivateFeedGrant</strong>
                    <p className="text-sm mt-1">
                      Created for each approved follower. Contains their leaf slot assignment and an encrypted
                      bundle of path keys + current CEK. ~500 bytes per follower.
                    </p>
                  </li>
                  <li className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
                    <strong className="text-gray-900 dark:text-gray-100">PrivateFeedRekey</strong>
                    <p className="text-sm mt-1">
                      Created on each revocation. Contains rekey packets (new keys encrypted for sibling subtrees),
                      the new epoch number, and a state snapshot for recovery. ~1-2 KB.
                    </p>
                  </li>
                  <li className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
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
            <div className="pt-6 border-t border-gray-200 dark:border-gray-800">
              <h2 className="text-xl font-semibold mb-4">Resources</h2>
              <div className="grid md:grid-cols-2 gap-4">
                <a
                  href="https://github.com/pastapastapasta/yappr/blob/master/docs/YAPPR_PRIVATE_FEED_SPEC_v1.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block bg-gray-50 dark:bg-gray-950 rounded-lg p-4 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
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
                  className="block bg-gray-50 dark:bg-gray-950 rounded-lg p-4 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
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
                  className="block bg-gray-50 dark:bg-gray-950 rounded-lg p-4 hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                >
                  <h3 className="font-medium text-gray-900 dark:text-gray-100">Dash Platform Documentation</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Learn about the underlying blockchain technology
                  </p>
                </a>
              </div>
              <p className="text-sm text-gray-500 mt-6">Last updated: January 2025</p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
