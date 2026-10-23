'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowTopRightOnSquareIcon, ChevronRightIcon, ScaleIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useModeratorElections } from '@/hooks/use-moderator-elections'
import { electionBanner, type ElectionBannerContent } from '@/lib/election-banner'
import { moderatedContract } from '@/lib/moderated-contracts'
import { masternodeVoteUrl, teamsHref } from '@/lib/moderation-charters/links'
import { CHARTERS_CONTRACT_ID } from '@/lib/moderation-charters/rules.mjs'
import { scopedKey } from '@/lib/storage-scope'

/** The banner a visitor hid this tab session, by its signature: a new phase brings it back. */
const DISMISSED_KEY = scopedKey('election-banner-dismissed')

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

function writeDismissed(signature: string) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, signature)
  } catch {
    // Storage blocked: it stays hidden until the page reloads.
  }
}

/** Where a page layout lets the banner sit (its centre column); none, and it spans the top of the screen. */
const SlotContext = createContext<(node: HTMLDivElement | null) => void>(() => undefined)

/**
 * The place for the election banner at the top of a layout's centre column,
 * above its sticky header, so it scrolls away with the page and leaves the
 * sticky sidebars alone. Renders an empty element; the banner itself is
 * mounted once, by {@link ElectionBannerFrame}.
 */
export function ElectionBannerSlot() {
  return <div ref={useContext(SlotContext)} />
}

/**
 * The app shell's moderator election banner, on every screen while a
 * contract's first moderation team is still being elected (`notYetUsable`
 * interim): what stays closed, the phase with its local date and time, and
 * where to go. One banner, one shared read: it sits in the page's
 * {@link ElectionBannerSlot} when the layout has one, else across the top.
 */
export function ElectionBannerFrame({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const pending = useModeratorElections()
  const content = useMemo(() => (pending ? electionBanner(pending) : null), [pending])
  // The static HTML never shows the banner (there is nothing to show before the client reads), so this cannot mismatch.
  const [dismissed, setDismissed] = useState<string | null>(readDismissed)
  const pathname = usePathname()

  const banner = content && dismissed !== content.signature
    ? (
        <ElectionBanner
          content={content}
          onTeamsPage={pathname.startsWith('/moderation-teams')}
          onDismiss={() => {
            writeDismissed(content.signature)
            setDismissed(content.signature)
          }}
        />
      )
    : null

  return (
    <SlotContext.Provider value={setSlot}>
      {slot ? banner && createPortal(banner, slot) : banner}
      {children}
    </SlotContext.Provider>
  )
}

/**
 * The strip itself. On a test network the network pill hangs from the top
 * edge over the middle of the screen; the strip's top padding is the pill's
 * height (`--network-pill-height`, set while the pill is shown) so its text
 * starts below it.
 */
function ElectionBanner({ content, onTeamsPage, onDismiss }: { content: ElectionBannerContent; onTeamsPage: boolean; onDismiss: () => void }) {
  const { headline, detail, teamsContract, voteContract } = content
  const voteUrl = voteContract ? masternodeVoteUrl(moderatedContract(voteContract).contractId, CHARTERS_CONTRACT_ID) : null
  const linkClass = 'inline-flex items-center gap-0.5 whitespace-nowrap font-semibold text-amber-950 underline-offset-2 hover:underline dark:text-amber-50'

  return (
    <div
      role="region"
      aria-label="Moderator elections"
      data-testid="election-banner"
      className="border-b border-amber-200 bg-amber-50 px-4 pb-2 pt-[var(--network-pill-height,0.5rem)] text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-5xl items-start gap-2">
        <ScaleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="min-w-0">
            <span className="font-semibold">{headline}.</span> <span data-testid="election-banner-detail">{detail}</span>
          </p>
          {(!onTeamsPage || voteUrl) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {!onTeamsPage && (
                <Link href={teamsHref(teamsContract)} data-testid="election-banner-teams" className={linkClass}>
                  Moderation teams <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              )}
              {voteUrl && (
                <a href={voteUrl} target="_blank" rel="noopener noreferrer" data-testid="election-banner-vote" className={linkClass}>
                  See the vote <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Hide this notice"
          onClick={onDismiss}
          className="-mr-1 rounded-full p-1 text-amber-700 hover:bg-amber-100 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300 dark:hover:bg-amber-900/60 dark:hover:text-amber-50"
        >
          <XMarkIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
