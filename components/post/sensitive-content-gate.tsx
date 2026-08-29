'use client'

import { useState } from 'react'
import { EyeSlashIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'

// Reveals are session-local by design: this module-level set lets a reveal
// survive re-mounts (pagination re-renders, tab switches) but not a reload.
const revealedThisSession = new Set<string>()

// `frame` is the covered panel's minimum height, and it stays on the wrapper
// after the reveal too — otherwise a post shorter than the cover would collapse
// the moment it opens.
const VARIANT_STYLES = {
  card: { frame: 'min-h-[2rem]', icon: 'h-4 w-4', label: 'text-xs', button: 'px-3 py-1 text-xs' },
  embedded: { frame: 'min-h-[1.75rem]', icon: 'h-3.5 w-3.5', label: 'text-[11px]', button: 'px-2.5 py-0.5 text-[11px]' },
} as const

// Cards navigate on click and quote cards are links — a tap on the cover
// must do nothing except through the Show button.
function swallowClick(e: React.MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
}

interface SensitiveContentGateProps {
  /** Keys the session reveal, so every card mounted later for this post opens too */
  postId: string
  /** When false the gate is inert and just renders its children */
  active: boolean
  /** 'embedded' renders a tighter panel that fits inside a quote card */
  variant?: 'card' | 'embedded'
  children: React.ReactNode
}

/**
 * Opaque cover for NSFW posts.
 *
 * The content is laid out underneath the cover at its real size and hidden with
 * `visibility`, so revealing it only flips the cover off: the card keeps its
 * height and nothing below it moves. That is the whole point of covering rather
 * than replacing — a reveal must never shove the rest of the feed around.
 *
 * Hidden content is not painted, not selectable, not focusable and not exposed
 * to assistive tech, so nothing NSFW reaches the viewer before they ask for it;
 * it is in the DOM, though, and its media loads like any other card's. The cover
 * is a solid panel rather than a blur, so it is unaffected by potato mode and
 * can never be defeated by a missing CSS filter.
 */
export function SensitiveContentGate({ postId, active, variant = 'card', children }: SensitiveContentGateProps) {
  const [revealed, setRevealed] = useState(() => revealedThisSession.has(postId))

  if (!active) {
    return <>{children}</>
  }

  const styles = VARIANT_STYLES[variant]

  return (
    <div className={cn('relative', styles.frame)}>
      <div className={cn(!revealed && 'invisible')}>{children}</div>

      {!revealed && (
        <div
          data-testid="sensitive-gate"
          onClick={swallowClick}
          className={cn(
            'absolute inset-0 flex items-center justify-center gap-2 overflow-hidden rounded-xl px-3',
            'bg-gray-900 dark:bg-gray-950 dark:border dark:border-gray-800'
          )}
        >
          <EyeSlashIcon className={cn('shrink-0 text-gray-400', styles.icon)} />
          <p className={cn('min-w-0 truncate text-gray-300', styles.label)}>
            <span className="font-medium text-gray-100">NSFW</span>
            <span className="hidden sm:inline"> · The author flagged this post</span>
          </p>
          <button
            type="button"
            data-testid="sensitive-show-btn"
            // The wording next to it is dropped on narrow screens, so the
            // button carries the context on its own.
            aria-label="Show post flagged as NSFW"
            onClick={(e) => {
              swallowClick(e)
              revealedThisSession.add(postId)
              setRevealed(true)
            }}
            className={cn(
              'shrink-0 rounded-full bg-gray-100 font-semibold text-gray-900 transition-colors hover:bg-white',
              styles.button
            )}
          >
            Show
          </button>
        </div>
      )}
    </div>
  )
}
