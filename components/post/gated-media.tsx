'use client'

import { EyeSlashIcon, PhotoIcon } from '@heroicons/react/24/outline'
import { useSettingsStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { IpfsImage } from '@/components/ui/ipfs-image'
import type { Media } from '@/lib/types'
import type { MediaGate } from '@/hooks/use-media-gate'

interface GatedMediaPlaceholderProps {
  onReveal: () => void
  /** 'image' renders a full aspect-video block; 'preview' a compact row */
  kind: 'image' | 'preview'
  className?: string
}

/**
 * Frosted stand-in for media from a non-followed author. Renders no remote
 * content at all — the real image is only fetched after the user reveals it
 * (or disables gating in settings).
 */
export function GatedMediaPlaceholder({ onReveal, kind, className }: GatedMediaPlaceholderProps) {
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800',
        'bg-gradient-to-br from-gray-200 to-gray-300 dark:from-neutral-800 dark:to-neutral-900',
        kind === 'image' ? 'aspect-video w-full' : 'w-full',
        className
      )}
    >
      <div
        className={cn(
          'flex h-full w-full items-center justify-center bg-white/30 dark:bg-black/30',
          !potatoMode && 'backdrop-blur-xl',
          kind === 'image' ? 'flex-col gap-2 p-4' : 'gap-3 px-4 py-3'
        )}
      >
        <EyeSlashIcon className="h-6 w-6 shrink-0 text-neutral-500 dark:text-neutral-400" />
        <p className={cn('text-sm text-neutral-600 dark:text-neutral-400', kind === 'image' && 'text-center')}>
          Media from someone you don&apos;t follow
        </p>
        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onReveal()
          }}
          className="shrink-0 rounded-full bg-neutral-900/80 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-900 dark:bg-white/90 dark:text-neutral-900 dark:hover:bg-white"
        >
          Show
        </button>
      </div>
    </div>
  )
}

interface GatedPostMediaProps {
  media: Media
  gate: MediaGate
}

/**
 * A post-card media cell: the follow-gate placeholder while gated, otherwise
 * the image itself with IPFS multi-gateway failover.
 */
export function GatedPostMedia({ media, gate }: GatedPostMediaProps) {
  if (gate.gated) {
    return <GatedMediaPlaceholder kind="image" onReveal={gate.reveal} className="h-full rounded-none border-0" />
  }

  return (
    <IpfsImage
      src={media.url}
      alt={media.alt || ''}
      className="absolute inset-0 h-full w-full object-cover"
      fallback={
        <div className="flex h-full w-full items-center justify-center text-neutral-400 dark:text-neutral-600">
          <PhotoIcon className="h-8 w-8" />
        </div>
      }
    />
  )
}
