'use client'

import { useState } from 'react'
import { EyeSlashIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'

// Reveals are session-local by design: this module-level set lets a reveal
// survive re-mounts (pagination re-renders, tab switches) but not a reload.
const revealedThisSession = new Set<string>()

const VARIANT_STYLES = {
  card: { panel: 'gap-1.5 px-6 py-8', icon: 'h-6 w-6', title: 'text-sm', button: 'px-4 py-1.5 text-sm' },
  embedded: { panel: 'gap-1 px-4 py-5', icon: 'h-5 w-5', title: 'text-xs', button: 'px-3 py-1 text-xs' },
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
 * Opaque cover for NSFW posts. Until the viewer reveals it the content is
 * not mounted at all — nothing leaks into the DOM and no media is fetched.
 * Deliberately a solid panel rather than a blur, so it is unaffected by potato
 * mode and can never be defeated by a missing CSS filter.
 */
export function SensitiveContentGate({ postId, active, variant = 'card', children }: SensitiveContentGateProps) {
  const [revealed, setRevealed] = useState(() => revealedThisSession.has(postId))

  if (!active || revealed) {
    return <>{children}</>
  }

  const styles = VARIANT_STYLES[variant]

  return (
    <div
      data-testid="sensitive-gate"
      onClick={swallowClick}
      className={cn(
        'mt-2 flex flex-col items-center justify-center rounded-xl bg-gray-900 text-center dark:bg-gray-950 dark:border dark:border-gray-800',
        styles.panel
      )}
    >
      <EyeSlashIcon className={cn('text-gray-400', styles.icon)} />
      <p className={cn('font-medium text-gray-100', styles.title)}>NSFW</p>
      <p className="text-xs text-gray-400">
        The author flagged this post as NSFW
      </p>
      <button
        type="button"
        data-testid="sensitive-show-btn"
        onClick={(e) => {
          swallowClick(e)
          revealedThisSession.add(postId)
          setRevealed(true)
        }}
        className={cn(
          'mt-1.5 rounded-full bg-gray-100 font-semibold text-gray-900 transition-colors hover:bg-white',
          styles.button
        )}
      >
        Show
      </button>
    </div>
  )
}
