'use client'

import { useState } from 'react'
import { EyeSlashIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'

export { isSensitivePost } from '@/lib/sensitive-content'

// Reveals are session-local by design: this module-level set lets a reveal
// survive re-mounts (pagination re-renders, tab switches) but not a reload.
const revealedThisSession = new Set<string>()

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
 * Opaque cover for sensitive posts. Until the viewer reveals it the content is
 * not mounted at all — nothing leaks into the DOM and no media is fetched.
 * Deliberately a solid panel rather than a blur, so it is unaffected by potato
 * mode and can never be defeated by a missing CSS filter.
 */
export function SensitiveContentGate({ postId, active, variant = 'card', children }: SensitiveContentGateProps) {
  const [revealed, setRevealed] = useState(() => revealedThisSession.has(postId))

  if (!active || revealed) {
    return <>{children}</>
  }

  return (
    <div
      data-testid="sensitive-gate"
      onClick={(e) => {
        // Cards navigate on click and quote cards are links — a tap on the
        // cover should do nothing except through the Show button.
        e.preventDefault()
        e.stopPropagation()
      }}
      className={cn(
        'mt-2 flex flex-col items-center justify-center rounded-xl bg-gray-900 text-center dark:bg-gray-950 dark:border dark:border-gray-800',
        variant === 'card' ? 'gap-1.5 px-6 py-8' : 'gap-1 px-4 py-5'
      )}
    >
      <EyeSlashIcon className={cn('text-gray-400', variant === 'card' ? 'h-6 w-6' : 'h-5 w-5')} />
      <p className={cn('font-medium text-gray-100', variant === 'card' ? 'text-sm' : 'text-xs')}>
        NSFW
      </p>
      <p className="text-xs text-gray-400">
        The author flagged this post as NSFW
      </p>
      <button
        type="button"
        data-testid="sensitive-show-btn"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          revealedThisSession.add(postId)
          setRevealed(true)
        }}
        className={cn(
          'mt-1.5 rounded-full bg-gray-100 font-semibold text-gray-900 transition-colors hover:bg-white',
          variant === 'card' ? 'px-4 py-1.5 text-sm' : 'px-3 py-1 text-xs'
        )}
      >
        Show
      </button>
    </div>
  )
}
